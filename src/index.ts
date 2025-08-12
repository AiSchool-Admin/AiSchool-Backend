import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const port = process.env.PORT || 3000;

// --- Client Initialization ---
let supabase: SupabaseClient | null = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

let anthropic: Anthropic | null = null;
if (process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Authentication Middleware ---
const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    if (!supabase) return res.status(500).json({ error: "Server not initialized." });
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid token' });
    (req as any).user = user;
    next();
};

// --- API Endpoints ---
app.get('/', (req, res) => res.status(200).send('AiSchool Backend is running!'));

app.post('/api/login', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Server not initialized." });
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    res.status(200).json({ message: 'Login successful.', session: data.session });
});

app.post('/api/register', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Database client not initialized." });
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const { data: { user }, error: authError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (authError) return res.status(400).json({ error: authError.message });
    if (!user) return res.status(500).json({ error: 'User created but no user data returned.' });
    const initialProfile = { id: user.id, skill_profile: {}, preferences: { style: "simplified", tutorPersona: { name: "Professor Khalid", gender: "male" } } };
    const { error: profileError } = await supabase.from('student_profiles').insert(initialProfile);
    if (profileError) return res.status(500).json({ error: `User auth created, but profile creation failed: ${profileError.message}` });
    res.status(201).json({ message: 'User registered successfully.', user });
});

app.get('/api/curriculums', authenticate, async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Server not initialized." });
    const { data, error } = await supabase.from('curriculums').select('id, country_code, data');
    if (error) return res.status(500).json({ error: error.message });
    res.status(200).json(data);
});

app.put('/api/profiles/preferences', authenticate, async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Server not initialized." });
    const user = (req as any).user;
    const newPreferences = req.body;
    if (!newPreferences || Object.keys(newPreferences).length === 0) return res.status(400).json({ error: 'No preference data provided.' });
    const { data, error } = await supabase.from('student_profiles').update({ preferences: newPreferences }).eq('id', user.id).select();
    if (error) return res.status(500).json({ error: error.message });
    res.status(200).json({ message: 'Preferences updated successfully.', data });
});

app.post('/api/units/:unitId/diagnostic-test', authenticate, async (req, res) => {
    if (!supabase || !anthropic) return res.status(500).json({ error: "Server not fully initialized." });
    const { unitId } = req.params;
    const { data: curriculums, error: curriculumError } = await supabase.from('curriculums').select('data').limit(1);
    if (curriculumError || !curriculums || curriculums.length === 0) return res.status(404).json({ error: 'No curriculums found.' });
    const curriculum = curriculums[0].data;
    let unitObjectives: string[] = [];
    let unitFound = false;
    for (const subject of curriculum.subjects) {
        for (const unit of subject.units) {
            if (unit.unitId === unitId) {
                unit.chapters[0]?.lessons.forEach((lesson: any) => {
                    unitObjectives.push(...lesson.objectives);
                });
                unitFound = true;
                break;
            }
        }
        if (unitFound) break;
    }
    if (!unitFound || unitObjectives.length === 0) return res.status(404).json({ error: `Unit with ID '${unitId}' not found or has no objectives.` });
    const prompt = `Generate a diagnostic test of 3 multiple-choice questions for a student. The test should assess their basic understanding of the following learning objectives: ${unitObjectives.join(', ')}. For each question, provide 4 options (A, B, C, D) and indicate the correct answer. Return the response as a JSON object with a single key "questions" which is an array of question objects. Each object should have "question_text", "options" (an object with A, B, C, D keys), and "correct_answer" (a string like "A").`;
    try {
        const aiResponse = await anthropic.messages.create({
            model: "claude-3-haiku-20240307",
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
        });
        const generatedJson = JSON.parse(aiResponse.content[0].text);
        res.status(200).json(generatedJson);
    } catch (aiError) {
        console.error("AI generation failed:", aiError);
        res.status(500).json({ error: 'Failed to generate diagnostic test.' });
    }
});

app.listen(port, () => console.log(`Server is running on port ${port}`));
