import express from 'express';
import cors from 'cors';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const app = express();
const port = process.env.PORT || 3000;

// --- Supabase Initialization ---
let supabase: SupabaseClient | null = null;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (supabaseUrl && supabaseServiceKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseServiceKey);
        console.log("Supabase client created successfully.");
    } catch (error) {
        console.error("CRITICAL: Failed to create Supabase client.", error);
    }
} else {
    console.error("CRITICAL: Supabase URL or Service Key is MISSING.");
}

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- API Endpoints ---

// Health and Debug check endpoint
app.get('/api/debug', (req, res) => {
  res.json({ serverStatus: "OK", supabaseStatus: supabase ? "Initialized" : "Error" });
});

/**
 * FR-02 & FR-03: Student Registration and Profile Creation
 * Creates a new user and their initial student profile.
 */
app.post('/api/register', async (req, res) => {
    if (!supabase) {
        return res.status(500).json({ error: "Database client not initialized." });
    }

    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    // Step 1: Create the user in the authentication system
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: email,
        password: password,
        email_confirm: true // Auto-confirm email for MVP
    });

    if (authError) {
        console.error('Error creating user:', authError.message);
        return res.status(400).json({ error: authError.message });
    }

    if (!authData.user) {
         return res.status(500).json({ error: 'User created but no user data returned.' });
    }

    const userId = authData.user.id;
    console.log(`User created successfully with ID: ${userId}`);

    // Step 2: Create the corresponding student profile
    const initialProfile = {
        id: userId,
        skill_profile: {}, // Initially empty
        preferences: {
            style: "simplified",
            tutorPersona: { name: "Professor Khalid", gender: "male" }
        }
    };

    const { error: profileError } = await supabase
        .from('student_profiles')
        .insert(initialProfile);

    if (profileError) {
        console.error('Error creating student profile:', profileError.message);
        // This is a critical issue, we might need to delete the created user here in a real scenario
        return res.status(500).json({ error: `User auth created, but profile creation failed: ${profileError.message}` });
    }

    console.log(`Student profile created for user ID: ${userId}`);
    res.status(201).json({ message: 'User registered successfully.', user: authData.user });
});

// FR-01: Curriculum Map Ingestion
app.post('/api/curriculums', async (req, res) => {
    if (!supabase) { return res.status(500).json({ error: "Database client not initialized." }); }
    const { country_code, curriculum_data } = req.body;
    if (!country_code || !curriculum_data) { return res.status(400).json({ error: 'Missing data.' }); }
    const { data, error } = await supabase.from('curriculums').insert([{ country_code, data: curriculum_data }]).select();
    if (error) { return res.status(500).json({ error: error.message }); }
    res.status(201).json({ message: 'Curriculum ingested successfully.', data });
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
