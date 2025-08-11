import express from 'express';
import cors from 'cors';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const app = express();
const port = process.env.PORT || 3000;

// --- Supabase Initialization ---
let supabase: SupabaseClient | null = null;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

console.log("Checking for Supabase environment variables...");
if (supabaseUrl && supabaseServiceKey) {
    console.log("Supabase URL and Service Key FOUND.");
    try {
        supabase = createClient(supabaseUrl, supabaseServiceKey);
        console.log("Supabase client created successfully.");
    } catch (error) {
        console.error("CRITICAL: Failed to create Supabase client.", error);
    }
} else {
    console.error("CRITICAL: Supabase URL or Service Key is MISSING from environment variables.");
}

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- API Endpoints ---

// Health and Debug check endpoint
app.get('/api/debug', (req, res) => {
  let status = "OK";
  let supabaseStatus = "Not initialized. Check logs for critical errors.";

  if(supabase) {
    supabaseStatus = "Supabase client is initialized.";
  } else {
    status = "ERROR";
  }

  res.status(status === "OK" ? 200 : 500).json({ 
    serverStatus: status,
    supabaseStatus: supabaseStatus,
    variables: {
        isSupabaseUrlSet: !!process.env.SUPABASE_URL,
        isSupabaseServiceKeySet: !!process.env.SUPABASE_SERVICE_KEY
    }
  });
});

// Original health check endpoint
app.get('/', (req, res) => {
  res.status(200).send('AiSchool Backend is running!');
});

// FR-01: Curriculum Map Ingestion
app.post('/api/curriculums', async (req, res) => {
    if (!supabase) {
        return res.status(500).json({ error: "Database client is not initialized. Check server logs." });
    }

    const { country_code, curriculum_data } = req.body;
    if (!country_code || !curriculum_data) {
        return res.status(400).json({ error: 'Missing country_code or curriculum_data.' });
    }

    const { data, error } = await supabase
        .from('curriculums')
        .insert([{ country_code: country_code, data: curriculum_data }])
        .select();

    if (error) {
        console.error('Error inserting curriculum:', error);
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json({ message: 'Curriculum ingested successfully.', data: data });
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
