import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const port = process.env.PORT || 3000;

// --- Client Initialization ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let anthropic: Anthropic | null = null;
if (process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// --- Middleware & Auth ---
app.use(cors());
app.use(express.json());

const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'supersecretkey');
    (req as any).user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// --- API Endpoints ---
app.get('/', (req, res) => res.status(200).send('AiSchool Backend is running!'));
app.post('/api/register', async (req, res) => { /* existing code */ });
app.post('/api/login', async (req, res) => { /* existing code */ });
app.get('/api/curriculums', authenticate, async (req, res) => { /* existing code */ });
app.post('/api/curriculums', authenticate, async (req, res) => { /* existing code */ });

/**
 * FR-08 & FR-09: Personalized Lesson Generation
 * Generates a full lesson explanation using the AI.
 */
app.post('/api/lessons/:lessonId/generate', authenticate, async (req, res) => {
    if (!anthropic) return res.status(500).json({ error: "AI client not initialized." });

    const { lessonId } = req.params;
    const user = (req as any).user;

    try {
        // Fetch user preferences and curriculum in parallel
        const [prefsResult, curriculumResult] = await Promise.all([
            pool.query('SELECT preferences FROM users WHERE id = $1', [user.userId]),
            pool.query('SELECT data FROM curriculums LIMIT 1')
        ]);

        const preferences = prefsResult.rows[0]?.preferences || { style: 'simplified' };
        const curriculum = curriculumResult.rows[0]?.data;

        if (!curriculum) return res.status(404).json({ error: 'Curriculum not found.' });

        // Find the lesson objectives
        let lessonName = '';
        let lessonObjectives: string[] = [];
        let lessonFound = false;

        for (const subject of curriculum.subjects) {
            for (const unit of subject.units) {
                for (const chapter of unit.chapters) {
                    for (const lesson of chapter.lessons) {
                        if (lesson.lessonId === lessonId) {
                            lessonName = lesson.name;
                            lessonObjectives = lesson.objectives;
                            lessonFound = true;
                            break;
                        }
                    }
                    if (lessonFound) break;
                }
                if (lessonFound) break;
            }
            if (lessonFound) break;
        }

        if (!lessonFound) return res.status(404).json({ error: 'Lesson not found.' });

        const prompt = `You are an expert teacher. Explain the lesson "${lessonName}" in a ${preferences.style} style. The explanation should cover these objectives: ${lessonObjectives.join(', ')}. Format the entire response in Markdown.`;

        const aiResponse = await anthropic.messages.create({
            model: "claude-3-haiku-20240307",
            max_tokens: 2048,
            messages: [{ role: "user", content: prompt }],
        });

        res.status(200).json({ content: aiResponse.content[0].text });

    } catch (error) {
        console.error("Error generating lesson:", error);
        res.status(500).json({ error: 'Failed to generate lesson.' });
    }
});

// Start the server
app.listen(port, () => console.log(`Server is running on port ${port}`));
