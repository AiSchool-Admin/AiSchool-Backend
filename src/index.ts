// @ts-nocheck
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

// Create a dummy Redis client for fallback
const createDummyRedisClient = () => {
  return {
    get: async () => null,
    setEx: async () => {},
    del: async () => {},
    exists: async () => false,
    connect: async () => {},
    on: () => {}
  };
};

// Initialize Redis client with error handling
let redisClient;
try {
  // Attempt to load the Redis module
  const redisModule = await import('redis');
  redisClient = redisModule.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });
  
  redisClient.on('error', (err: Error) => console.error('Redis Client Error', err));
  await redisClient.connect();
  console.log('Redis connected successfully');
} catch (err) {
  console.error('Redis initialization failed. Using dummy client:', err.message);
  redisClient = createDummyRedisClient();
}

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

// CORS configuration
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// Helper functions
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

const findUnitById = (curriculums: any[], unitId: string): any | null => {
  for (const curriculum of curriculums) {
    const subjects = curriculum.data?.subjects || [];
    for (const subject of subjects) {
      const units = subject.units || [];
      const found = units.find((u: any) => u.unitId === unitId);
      if (found) return found;
    }
  }
  return null;
};

const updateQuota = async (userId: string, cost: number) => {
  await pool.query(
    'UPDATE users SET quota_used = quota_used + $1 WHERE id = $2',
    [cost, userId]
  );
};

const checkQuota = async (userId: string, cost: number) => {
  const result = await pool.query(
    'SELECT quota_used, quota_limit FROM users WHERE id = $1',
    [userId]
  );
  const { quota_used, quota_limit } = result.rows[0];
  return (quota_used + cost) <= quota_limit;
};

// Middleware
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required: No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload: any = jwt.verify(token, process.env.JWT_SECRET || 'supersecretkey');
    (req as any).user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed: Invalid token.' });
  }
};

const quotaCheck = (cost: number) => async (req: Request, res: Response, next: NextFunction) => {
  const { userId } = (req as any).user;
  try {
    const hasQuota = await checkQuota(userId, cost);
    if (!hasQuota) {
      return res.status(402).json({ error: 'Insufficient quota. Please upgrade your plan.' });
    }
    next();
  } catch (error) {
    console.error('Quota check error:', error);
    res.status(500).json({ error: 'Failed to check quota.' });
  }
};

// API Endpoints
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
    const newUserQuery = `
      INSERT INTO users(email, password_hash, preferences, skill_profile, quota_used, quota_limit) 
      VALUES($1, $2, $3, $4, 0, 1000) 
      RETURNING id, email
    `;
    const initialPreferences = { style: "simplified", tutorPersona: { name: "Professor Khalid", gender: "male" } };
    const initialSkillProfile = {};
    const result = await pool.query(newUserQuery, [
      email, 
      password_hash, 
      JSON.stringify(initialPreferences), 
      JSON.stringify(initialSkillProfile)
    ]);
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

app.post('/api/curriculums', authenticate, async (req, res) => {
  const { country_code, data } = req.body;
  if (!country_code || !data) {
    return res.status(400).json({ error: 'Country code and curriculum data are required.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO curriculums(country_code, data) VALUES($1, $2) RETURNING id',
      [country_code, JSON.stringify(data)]
    );
    res.status(201).json({ message: 'Curriculum added successfully', id: result.rows[0].id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to add curriculum.' });
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

app.put('/api/preferences', authenticate, async (req, res) => {
  const { userId } = (req as any).user;
  const { preferences } = req.body;
  
  if (!preferences) {
    return res.status(400).json({ error: 'Preferences are required.' });
  }
  
  try {
    await pool.query(
      'UPDATE users SET preferences = $1 WHERE id = $2',
      [JSON.stringify(preferences), userId]
    );
    res.status(200).json({ message: 'Preferences updated successfully.' });
  } catch (error) {
    console.error('Error updating preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences.' });
  }
});

app.post('/api/units/:unitId/diagnostic-test', authenticate, quotaCheck(5), async (req, res) => {
  const { unitId } = req.params;
  const { userId } = (req as any).user;

  try {
    const curriculumResult = await pool.query('SELECT data FROM curriculums');
    const unit = findUnitById(curriculumResult.rows, unitId);
    if (!unit) {
      return res.status(404).json({ error: 'Unit not found.' });
    }

    // Get all objectives in the unit
    let objectives: string[] = [];
    unit.chapters.forEach((chapter: any) => {
      chapter.lessons.forEach((lesson: any) => {
        objectives = [...objectives, ...lesson.objectives];
      });
    });

    const prompt = `
      Create a diagnostic test with 5 questions covering these key objectives: 
      ${objectives.join(', ')}. 
      Format as JSON: { "questions": [ { "question": "...", "options": ["...", "..."], "answer": 0 } ] }
    `;

    const aiResponse = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const responseText = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : '';
    const jsonStartIndex = responseText.indexOf('{');
    const jsonEndIndex = responseText.lastIndexOf('}') + 1;
    
    if (jsonStartIndex !== -1 && jsonEndIndex > jsonStartIndex) {
      const jsonString = responseText.substring(jsonStartIndex, jsonEndIndex);
      try {
        const testData = JSON.parse(jsonString);
        await updateQuota(userId, 5);
        res.status(200).json(testData);
      } catch (parseError) {
        console.error("Failed to parse JSON from AI response:", parseError);
        throw new Error("AI returned malformed JSON.");
      }
    } else {
      throw new Error("Could not find a valid JSON object in the AI response.");
    }

  } catch (error) {
    console.error(`Error generating diagnostic test for unit ${unitId}:`, error);
    res.status(500).json({ error: 'Failed to generate diagnostic test.' });
  }
});

app.post('/api/lessons/:lessonId/generate', authenticate, quotaCheck(10), async (req, res) => {
  const { lessonId } = req.params;
  const { userId } = (req as any).user;

  try {
    // Check cache first
    const cacheKey = `lesson:${lessonId}:${userId}`;
    const cachedLesson = await redisClient.get(cacheKey);
    if (cachedLesson) {
      return res.status(200).json(JSON.parse(cachedLesson));
    }

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
      After the explanation, on a new line, write the text "KEYWORDS:" followed by a comma-separated list of the most important terms from the lesson.
      
      Example:
      ## What is Photosynthesis?
      Photosynthesis is the process plants use...
      
      KEYWORDS: Photosynthesis, light energy, chemical energy
    `;

    const aiResponse = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    const responseText = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : '';
    
    // Parse response
    let lessonContent = responseText;
    let keywords: string[] = [];
    const keywordMarker = "KEYWORDS:";
    const keywordIndex = responseText.lastIndexOf(keywordMarker);

    if (keywordIndex !== -1) {
      lessonContent = responseText.substring(0, keywordIndex).trim();
      const keywordString = responseText.substring(keywordIndex + keywordMarker.length).trim();
      keywords = keywordString.split(',').map(k => k.trim()).filter(k => k);
    }

    // Cache result
    const responseData = { content: lessonContent, keywords };
    await redisClient.setEx(cacheKey, 3600, JSON.stringify(responseData)); // Cache for 1 hour
    await updateQuota(userId, 10);

    res.status(200).json(responseData);

  } catch (error) {
    console.error(`Error generating lesson for ${lessonId}:`, error);
    res.status(500).json({ error: 'Failed to generate lesson content.' });
  }
});

app.post('/api/lessons/:lessonId/questions', authenticate, quotaCheck(5), async (req, res) => {
  const { lessonId } = req.params;
  const { userId } = (req as any).user;

  try {
    const curriculumResult = await pool.query('SELECT data FROM curriculums');
    const lessonDetails = findLessonById(curriculumResult.rows, lessonId);
    if (!lessonDetails) {
      return res.status(404).json({ error: 'Lesson details not found.' });
    }

    const prompt = `
      Based on the lesson "${lessonDetails.name}" with objectives "${lessonDetails.objectives.join(', ')}", 
      generate 3 multiple-choice questions to test understanding at different difficulty levels.
      Format as JSON: { "questions": [ { "difficulty": "easy", "question": "...", "options": ["...", "..."], "answer": 0 } ] }
    `;

    const aiResponse = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
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
        await updateQuota(userId, 5);
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
    
    // Invalidate cached lesson
    await redisClient.del(`lesson:${lessonId}:${userId}`);
    
    res.status(200).json({ message: 'Skill profile updated successfully.' });

  } catch (error) {
    console.error(`Error updating skill for lesson ${lessonId}:`, error);
    res.status(500).json({ error: 'Failed to update skill profile.' });
  }
});

app.post('/api/homework/submit', authenticate, upload.single('homeworkImage'), async (req, res) => {
  const { userId } = (req as any).user;
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded.' });
  }

  try {
    // Check quota before processing
    const hasQuota = await checkQuota(userId, 15);
    if (!hasQuota) {
      return res.status(402).json({ error: 'Insufficient quota. Please upgrade your plan.' });
    }

    const result = await pool.query(
      'INSERT INTO homework_jobs (user_id) VALUES ($1) RETURNING id',
      [userId]
    );
    const jobId = result.rows[0].id;
    res.status(202).json({ message: 'Homework submission accepted.', jobId: jobId });
    
    // Process in background
    processHomeworkJob(jobId, req.file.buffer, req.file.mimetype, userId);

  } catch (error) {
    console.error("Error submitting homework:", error);
    res.status(500).json({ error: 'Failed to submit homework problem.' });
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
    await updateQuota(userId, 15);

  } catch (error: any) {
    console.error(`Processing failed for job ${jobId}:`, error);
    const failureReason = error.message || "An unknown error occurred during AI processing.";
    await pool.query("UPDATE homework_jobs SET status = 'failed', failure_reason = $1 WHERE id = $2", [failureReason, jobId]);
  }
};

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

app.post('/api/explain-term', authenticate, quotaCheck(1), async (req, res) => {
  const { term } = req.body;
  const { userId } = (req as any).user;
  
  if (!term) {
    return res.status(400).json({ error: 'Term is required.' });
  }

  try {
    // Check cache first
    const cacheKey = `term:${term}`;
    const cachedExplanation = await redisClient.get(cacheKey);
    if (cachedExplanation) {
      await updateQuota(userId, 1);
      return res.status(200).json({ explanation: cachedExplanation });
    }

    const prompt = `Explain the term "${term}" in a simple, concise way for a high school student.`;
    
    const aiResponse = await anthropic.messages.create({
      model: "claude-3-haiku-20240307", 
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });

    const explanation = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : "Sorry, I could not generate an explanation.";
    
    // Cache result
    await redisClient.setEx(cacheKey, 86400, explanation); // Cache for 24 hours
    await updateQuota(userId, 1);
    
    res.status(200).json({ explanation });

  } catch (error) {
    console.error(`Error explaining term "${term}":`, error);
    res.status(500).json({ error: 'Failed to explain term.' });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
