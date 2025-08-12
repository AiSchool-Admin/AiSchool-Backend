import express from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const app = express();
const port = process.env.PORT || 3000;

console.log('--- Starting Server ---');

// --- Supabase Initialization & Diagnostics ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
let supabase: SupabaseClient | null = null;

if (supabaseUrl && supabaseServiceKey) {
    console.log(`Found Supabase URL: ${supabaseUrl}`);
    console.log(`Found Supabase Service Key: [Present, Length: ${supabaseServiceKey.length}]`);
    supabase = createClient(supabaseUrl, supabaseServiceKey);
} else {
    console.error('CRITICAL: Supabase environment variables not found.');
}

// --- API Endpoints ---
app.get('/', (req, res) => {
    res.status(200).send('AiSchool Backend is running!');
});

// New endpoint to specifically test the database connection
app.get('/api/db-test', async (req, res) => {
    console.log('--- Running DB Connection Test ---');
    if (!supabase) {
        console.error('DB Test Failed: Supabase client not initialized.');
        return res.status(500).json({ status: 'Failed', error: 'Supabase client not initialized.' });
    }

    // This is a simple query just to see if we can talk to the database at all.
    const { data, error } = await supabase.from('student_profiles').select('id').limit(1);

    if (error) {
        console.error('DB Test Failed with error:', error);
        return res.status(500).json({ status: 'Failed', message: 'Could not connect to the database.', error: error.message });
    }

    console.log('DB Test Succeeded.');
    res.status(200).json({ status: 'Success', message: 'Successfully connected to the database and fetched data.' });
});


// --- Server Start ---
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
