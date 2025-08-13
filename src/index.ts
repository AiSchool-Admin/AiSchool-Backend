import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
// Assume you'll add an AI client, like Anthropic for Claude
// import Anthropic from '@anthropic-ai/sdk';

const app = express();
const port = process.env.PORT || 3000;

// --- Database Initialization with SSL Configuration ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/*
// --- AI Client Initialization ---
// You would initialize your AI client here once you have the API key
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
*/


// --- Middleware ---
app.use(cors());
app.use(express.json());

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

// --- NEW ENDPOINT TO FIX THE 404 ERROR ---
app.post('/api/lessons/:lessonId/generate', authenticate, async (req, res) => {
    const { lessonId } = req.params;
    // const { userId } = (req as any).user; // You can get the user ID from the token

    try {
        // --- Step 1: Find the lesson details from the database ---
        // This is a placeholder. In a real scenario, you would query your database
        // to find the lesson's objectives, keywords, etc., based on the lessonId.
        // For example:
        // const lessonResult = await pool.query('SELECT ... FROM curriculums WHERE ...');
        // const lessonDetails = findLessonInJson(lessonResult.rows, lessonId);
        // if (!lessonDetails) {
        //   return res.status(404).json({ error: 'Lesson details not found in curriculum.' });
        // }

        console.log(`Generating lesson for ID: ${lessonId}`);

        // --- Step 2: Call the AI model to generate content ---
        // This is where you would use the lesson details to build a prompt
        // and send it to the Claude API via the Anthropic client.
        /*
        const msg = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 1024,
            messages: [{ role: "user", content: `Explain the concept of ${lessonDetails.name}` }],
        });
        const lessonContent = msg.content[0].text;
        */
       
        // For now, we return placeholder content to confirm the endpoint works.
        const lessonContent = `This is the generated lesson for lesson ID: ${lessonId}. The backend endpoint is now working correctly! You can now integrate the real AI call.`;

        // --- Step 3: Send the generated content back to the app ---
        res.status(200).json({ content: lessonContent });

    } catch (error) {
        console.error(`Error generating lesson for ${lessonId}:`, error);
        res.status(500).json({ error: 'Failed to generate lesson content.' });
    }
});


// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
