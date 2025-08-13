import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Anthropic from '@anthropic-ai/sdk';
import multer from 'multer';

const app = express();
const port = process.env.PORT || 3000;

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// --- Explicit CORS Configuration ---
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json());

// --- Helper functions and middleware ---
const findLessonById = (curriculums: any[], lessonId: string): any | null => {
    for (const curriculum of curriculums) {
        const subjects = curriculum.data?.subjects || [];
        for (const subject of subjects) {
            const units = subject.units || [];
            for (const unit of units) {
                const chapters = unit.chapters || [];
                for (const chapter of chapters) {
                    const lessons = chapter.lessons || [];
                    const found = lessons.find((l: any) => l.lessonId === lessonId);
                    if (found) return found;
                }
            }
        }
    }
    return null;
};

const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required: No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'supersecretkey');
    (req as any).user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed: Invalid token.' });
  }
};


// --- API Endpoints ---
app.get('/', (req, res) => {
  res.status(200).send('AiSchool Backend is running!');
});

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  try {
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const newUserQuery = 'INSERT INTO users(email, password_hash, preferences, skill_profile) VALUES($1, $2, $3, $4) RETURNING id, email';
    const initialPreferences = { style: "simplified", tutorPersona: { name: "Professor Khalid", gender: "male" } };
    const initialSkillProfile = {};
    const result = await pool.query(newUserQuery, [email, password_hash, JSON.stringify(initialPreferences), JSON.stringify(initialSkillProfile)]);
    res.status(201).json({ message: 'User registered successfully', user: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to register user.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'supersecretkey', { expiresIn: '1h' });
    res.json({ message: 'Login successful', token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.get('/api/curriculums', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, country_code, data FROM curriculums');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch curriculums.' });
    }
});

app.post('/api/lessons/:lessonId/generate', authenticate, async (req, res) => {
    const { lessonId } = req.params;
    const { userId } = (req as any).user;

    try {
        const [curriculumResult, userResult] = await Promise.all([
            pool.query('SELECT data FROM curriculums'),
            pool.query('SELECT preferences, skill_profile FROM users WHERE id = $1', [userId])
        ]);

        const lessonDetails = findLessonById(curriculumResult.rows, lessonId);
        if (!lessonDetails) {
          return res.status(404).json({ error: 'Lesson details not found in curriculum.' });
        }

        const user = userResult.rows[0];
        const learningPreferences = user.preferences || { style: "simplified", tutorPersona: { name: "Professor Khalid" } };
        const skillProfile = user.skill_profile || {};
        const masteryScore = skillProfile[lessonId]?.masteryScore || 0.0;

        const prompt = `
            Role: You are an expert teacher named ${learningPreferences.tutorPersona.name}.
            Persona: Explain in a ${learningPreferences.style} style.
            Context: The student has a current mastery level of ${masteryScore * 100}% in this lesson.
            Task: Provide a clear and comprehensive explanation for the lesson "${lessonDetails.name}".
            The lesson's main objectives are: ${lessonDetails.objectives.join(', ')}.
            Focus on the core concepts and use simple analogies if possible.
            Output Format: Provide the explanation in simple Markdown.
        `;

        const aiResponse = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
        });

        const firstBlock = aiResponse.content[0];
        if (firstBlock.type === 'text') {
            const lessonContent = firstBlock.text;
            res.status(200).json({ content: lessonContent, keywords: lessonDetails.keywords || [] });
        } else {
            throw new Error("AI response was not in the expected text format.");
        }

    } catch (error) {
        console.error(`Error generating lesson for ${lessonId}:`, error);
        res.status(500).json({ error: 'Failed to generate lesson content.' });
    }
});

app.post('/api/lessons/:lessonId/questions', authenticate, async (req, res) => {
    const { lessonId } = req.params;

    try {
        const curriculumResult = await pool.query('SELECT data FROM curriculums');
        const lessonDetails = findLessonById(curriculumResult.rows, lessonId);
        if (!lessonDetails) {
            return res.status(404).json({ error: 'Lesson details not found.' });
        }

        const prompt = `
            Based on the lesson "${lessonDetails.name}" with objectives "${lessonDetails.objectives.join(', ')}", generate 3 multiple-choice questions to test understanding.
            For each question, provide: The question text, a list of 4 possible options, and the index (0-3) of the correct option.
            Return the output as a single, valid JSON object with a key "questions" which is an array of question objects.
        `;

        const aiResponse = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
        });

        const responseText = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : '';
        const jsonStartIndex = responseText.indexOf('{');
        const jsonEndIndex = responseText.lastIndexOf('}') + 1;

        if (jsonStartIndex !== -1 && jsonEndIndex > jsonStartIndex) {
            const jsonString = responseText.substring(jsonStartIndex, jsonEndIndex);
            try {
                const questionsJson = JSON.parse(jsonString);
                res.status(200).json(questionsJson);
            } catch (parseError) {
                console.error("Failed to parse JSON from AI response:", parseError);
                throw new Error("AI returned malformed JSON.");
            }
        } else {
            throw new Error("Could not find a valid JSON object in the AI response.");
        }

    } catch (error) {
        console.error(`Error generating questions for ${lessonId}:`, error);
        res.status(500).json({ error: 'Failed to generate questions.' });
    }
});

app.post('/api/lessons/:lessonId/update-skill', authenticate, async (req, res) => {
    const { lessonId } = req.params;
    const { score, totalQuestions } = req.body;
    const { userId } = (req as any).user;

    if (score === undefined || totalQuestions === undefined) {
        return res.status(400).json({ error: 'Score and totalQuestions are required.' });
    }

    try {
        const userResult = await pool.query('SELECT skill_profile FROM users WHERE id = $1', [userId]);
        const skillProfile = userResult.rows[0]?.skill_profile || {};
        const newMastery = totalQuestions > 0 ? score / totalQuestions : 0;

        skillProfile[lessonId] = {
            masteryScore: newMastery,
            confidence: newMastery > 0.7 ? 'high' : newMastery > 0.4 ? 'medium' : 'low',
            lastAttempt: new Date().toISOString(),
        };

        await pool.query('UPDATE users SET skill_profile = $1 WHERE id = $2', [JSON.stringify(skillProfile), userId]);
        res.status(200).json({ message: 'Skill profile updated successfully.' });

    } catch (error) {
        console.error(`Error updating skill for lesson ${lessonId}:`, error);
        res.status(500).json({ error: 'Failed to update skill profile.' });
    }
});

const processHomeworkJob = async (jobId: string, imageBuffer: Buffer, imageMediaType: string, userId: string) => {
    try {
        await pool.query("UPDATE homework_jobs SET status = 'processing' WHERE id = $1", [jobId]);

        const userResult = await pool.query('SELECT preferences FROM users WHERE id = $1', [userId]);
        const learningPreferences = userResult.rows[0]?.preferences || { style: "simplified" };
        const imageBase64 = imageBuffer.toString('base64');

        const prompt = `
            You are an expert tutor. A student has sent a picture of their homework.
            Analyze the image and help the student.
            - If the image contains a question or problem, provide a clear, step-by-step solution.
            - If the image contains explanatory text, a diagram, or a concept, summarize and explain the main ideas clearly.
            - If you cannot understand the image, say so politely.
            Explain everything in a ${learningPreferences.style} style and format your response using simple Markdown.
        `;

        const aiResponse = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 2048,
            messages: [{
                role: "user",
                content: [{
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: imageMediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                        data: imageBase64,
                    },
                }, {
                    type: "text",
                    text: prompt,
                }],
            }],
        });

        const solution = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : "Sorry, I couldn't find a text solution.";
        await pool.query("UPDATE homework_jobs SET status = 'completed', solution = $1 WHERE id = $2", [solution, jobId]);

    } catch (error: any) {
        console.error(`Processing failed for job ${jobId}:`, error);
        const failureReason = error.message || "An unknown error occurred during AI processing.";
        await pool.query("UPDATE homework_jobs SET status = 'failed', failure_reason = $1 WHERE id = $2", [failureReason, jobId]);
    }
};

app.post('/api/homework/submit', authenticate, upload.single('homeworkImage'), async (req, res) => {
    const { userId } = (req as any).user;
    if (!req.file) {
        return res.status(400).json({ error: 'No image file uploaded.' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO homework_jobs (user_id) VALUES ($1) RETURNING id',
            [userId]
        );
        const jobId = result.rows[0].id;
        res.status(202).json({ message: 'Homework submission accepted.', jobId: jobId });
        processHomeworkJob(jobId, req.file.buffer, req.file.mimetype, userId);
    } catch (error) {
        console.error("Error submitting homework:", error);
        res.status(500).json({ error: 'Failed to submit homework problem.' });
    }
});

app.get('/api/homework/status/:jobId', authenticate, async (req, res) => {
    const { jobId } = req.params;
    const { userId } = (req as any).user;

    try {
        const result = await pool.query(
            'SELECT status, solution, failure_reason FROM homework_jobs WHERE id = $1 AND user_id = $2',
            [jobId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found.' });
        }

        const job = result.rows[0];
        res.status(200).json({ status: job.status, solution: job.solution, failureReason: job.failure_reason });

    } catch (error) {
        console.error(`Error fetching status for job ${jobId}:`, error);
        res.status(500).json({ error: 'Failed to fetch job status.' });
    }
});

app.post('/api/explain-term', authenticate, async (req, res) => {
    const { term } = req.body;
    if (!term) {
        return res.status(400).json({ error: 'Term is required.' });
    }

    try {
        const prompt = `Explain the term "${term}" in a simple, concise way for a high school student.`;
        
        const aiResponse = await anthropic.messages.create({
            model: "claude-3-haiku-20240307", 
            max_tokens: 200,
            messages: [{ role: "user", content: prompt }],
        });

        const explanation = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : "Sorry, I could not generate an explanation.";
        res.status(200).json({ explanation });

    } catch (error) {
        console.error(`Error explaining term "${term}":`, error);
        res.status(500).json({ error: 'Failed to explain term.' });
    }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
