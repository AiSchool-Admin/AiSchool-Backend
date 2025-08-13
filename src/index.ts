import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Anthropic from '@anthropic-ai/sdk';
import multer from 'multer';
import fs from 'fs';

const app = express();
const port = process.env.PORT || 3000;

// --- Multer setup for file uploads ---
const upload = multer({ dest: 'uploads/' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(cors());
app.use(express.json());

// --- (Existing helper functions and middleware remain the same) ---
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

// --- (Existing API endpoints remain the same) ---
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
            res.status(200).json({ content: lessonContent });
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
            For each question, provide:
            - The question text.
            - A list of 4 possible options.
            - The index (0-3) of the correct option.
            
            Return the output as a single, valid JSON object with a key "questions" which is an array of question objects.
            Example format:
            {
              "questions": [
                {
                  "questionText": "What is the capital of France?",
                  "options": ["London", "Berlin", "Paris", "Madrid"],
                  "correctOptionIndex": 2
                }
              ]
            }
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

// --- NEW ENDPOINT FOR HOMEWORK SOLVER ---
app.post('/api/homework/solve', authenticate, upload.single('homeworkImage'), async (req, res) => {
    const { userId } = (req as any).user;

    if (!req.file) {
        return res.status(400).json({ error: 'No image file uploaded.' });
    }

    try {
        // Fetch user preferences
        const userResult = await pool.query('SELECT preferences FROM users WHERE id = $1', [userId]);
        const learningPreferences = userResult.rows[0]?.preferences || { style: "simplified" };
        
        // Read the image file and convert to base64
        const imageBuffer = fs.readFileSync(req.file.path);
        const imageBase64 = imageBuffer.toString('base64');
        const imageMediaType = req.file.mimetype;

        // Construct the prompt for the multimodal AI
        const prompt = `
            You are an expert tutor. A student has sent a picture of a homework problem.
            Provide a clear, step-by-step solution to the problem in the image.
            Explain the solution in a ${learningPreferences.style} style.
            Output your response in simple Markdown.
        `;

        const aiResponse = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 2048,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image",
                            source: {
                                type: "base64",
                                // --- THIS IS THE FIX ---
                                // Add a type assertion to satisfy TypeScript
                                media_type: imageMediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                                data: imageBase64,
                            },
                        },
                        {
                            type: "text",
                            text: prompt,
                        }
                    ],
                }
            ],
        });

        const solution = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : "Sorry, I couldn't find a text solution in the response.";

        res.status(200).json({ solution });

    } catch (error) {
        console.error("Error solving homework:", error);
        res.status(500).json({ error: 'Failed to solve homework problem.' });
    } finally {
        // Clean up the uploaded file
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
    }
});


app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
