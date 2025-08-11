import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Allow large JSON payloads for curriculums

// Get Supabase credentials from environment variables
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || '';

// Create a single Supabase client for the app
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// --- API Endpoints ---

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).send('AiSchool Backend is running!');
});

/**
 * FR-01: Curriculum Map Ingestion
 * Endpoint to receive and store a new curriculum.
 */
app.post('/api/curriculums', async (req, res) => {
  console.log('Received request to ingest curriculum.');
  
  const { country_code, curriculum_data } = req.body;

  if (!country_code || !curriculum_data) {
    return res.status(400).json({ error: 'Missing country_code or curriculum_data in request body.' });
  }

  const { data, error } = await supabase
    .from('curriculums')
    .insert([
      { 
        country_code: country_code,
        data: curriculum_data
      }
    ])
    .select();

  if (error) {
    console.error('Error inserting curriculum:', error);
    return res.status(500).json({ error: error.message });
  }

  console.log('Successfully inserted curriculum:', data);
  res.status(201).json({ message: 'Curriculum ingested successfully.', data: data });
});


// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
