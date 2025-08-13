import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
// Import the Anthropic SDK for Claude
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const port = process.env.PORT || 3000;

// --- Database Initialization with SSL Configuration ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- AI Client Initialization ---
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});


// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Helper Function to find a lesson in the curriculum JSON ---
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


// --- Authentication Middleware ---
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

// -- Unprotected --
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
    const newUserQuery = 'INSERT INTO users(email, password_hash, preferences) VALUES($1, $2, $3) RETURNING id, email';
    const initialPreferences = { style: "simplified", tutorPersona: { name: "Professor Khalid", gender: "male" } };
    const result = await pool.query(newUserQuery, [email, password_hash, JSON.stringify(initialPreferences)]);
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

// -- Protected --

app.get('/api/curriculums', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, country_code, data FROM curriculums');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch curriculums.' });
    }
});

// --- FULLY IMPLEMENTED LESSON GENERATION ENDPOINT ---
app.post('/api/lessons/:lessonId/generate', authenticate, async (req, res) => {
    const { lessonId } = req.params;
    const { userId } = (req as any).user;

    try {
        // --- Step 1: Fetch all necessary data in parallel ---
        const [curriculumResult, userResult] = await Promise.all([
            pool.query('SELECT data FROM curriculums'),
            pool.query('SELECT preferences, skill_profile FROM users WHERE id = $1', [userId])
        ]);

        // --- Step 2: Find the specific lesson and user details ---
        const lessonDetails = findLessonById(curriculumResult.rows, lessonId);
        if (!lessonDetails) {
          return res.status(404).json({ error: 'Lesson details not found in curriculum.' });
        }
        
        const user = userResult.rows[0];
        const learningPreferences = user.preferences || { style: "simplified", tutorPersona: { name: "Professor Khalid" } };
        const skillProfile = user.skill_profile || {};
        const masteryScore = skillProfile[lessonId]?.masteryScore || 0.0;

        // --- Step 3: Build the dynamic prompt for the AI model ---
        const prompt = `
            Role: You are an expert teacher named ${learningPreferences.tutorPersona.name}.
            Persona: Explain in a ${learningPreferences.style} style.
            Context: The student has a current mastery level of ${masteryScore * 100}% in this lesson.
            Task: Provide a clear and comprehensive explanation for the lesson "${lessonDetails.name}".
            The lesson's main objectives are: ${lessonDetails.objectives.join(', ')}.
            Focus on the core concepts and use simple analogies if possible.
            Output Format: Provide the explanation in simple Markdown.
        `;

        // --- Step 4: Call the Claude API to generate the content ---
        const aiResponse = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620", // As specified in the PRD
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
        });
        
        // --- CORRECTED LOGIC TO FIX THE BUILD ERROR ---
        const firstBlock = aiResponse.content[0];
        if (firstBlock.type === 'text') {
            const lessonContent = firstBlock.text;
            // --- Step 5: Send the generated content back to the app ---
            res.status(200).json({ content: lessonContent });
        } else {
            // If the AI returns something other than text, which is an error for us.
            throw new Error("AI response was not in the expected text format.");
        }

    } catch (error) {
        console.error(`Error generating lesson for ${lessonId}:`, error);
        res.status(500).json({ error: 'Failed to generate lesson content.' });
    }
});


// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
