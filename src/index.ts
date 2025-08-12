import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const app = express();
const port = process.env.PORT || 3000;

// --- Supabase Initialization ---
let supabase: SupabaseClient | null = null;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (supabaseUrl && supabaseServiceKey) {
    supabase = createClient(supabaseUrl, supabaseServiceKey);
    console.log("Supabase client initialized.");
} else {
    console.error("CRITICAL: Supabase environment variables are missing.");
}

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Authentication Middleware (The "Security Guard") ---
const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    if (!supabase) return res.status(500).json({ error: "Server not initialized." });

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required: No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
        return res.status(401).json({ error: 'Authentication failed: Invalid token.' });
    }

    // Attach user to the request object for use in other endpoints
    (req as any).user = user;
    next(); // Proceed to the next function
};

// --- API Endpoints ---

// --- Unprotected Endpoints ---
app.get('/api/debug', (req, res) => res.json({ serverStatus: "OK" }));

app.post('/api/login', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Server not initialized." });
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) return res.status(401).json({ error: error.message });

    res.status(200).json({ message: 'Login successful.', session: data.session });
});

app.post('/api/register', async (req, res) => {
    // (Code from previous step - no changes needed here)
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

// --- Protected Endpoints (Require Authentication) ---

/**
 * FR-04 & FR-05: Customize Learning Preferences
 * Allows an authenticated user to update their learning preferences.
 */
app.put('/api/profiles/preferences', authenticate, async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Server not initialized." });

    const user = (req as any).user;
    const newPreferences = req.body;

    if (!newPreferences || Object.keys(newPreferences).length === 0) {
        return res.status(400).json({ error: 'No preference data provided.' });
    }

    const { data, error } = await supabase
        .from('student_profiles')
        .update({ preferences: newPreferences })
        .eq('id', user.id)
        .select();

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.status(200).json({ message: 'Preferences updated successfully.', data });
});


// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
