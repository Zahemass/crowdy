// index.js
import express from "express";
import { supabase } from "./supabaseClient.js";
import dotenv, { decrypt } from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import multer from "multer";
import axios from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import fsPromises from "fs/promises";
import os from "os";
import { execSync } from "child_process";
// import OpenAI from "openai";
import { Credentials, Translator } from "@translated/lara";






dotenv.config();



const app = express();
app.use(express.json());

//for openai
//const openai = new OpenAI({
//  apiKey: process.env.OPENAI_API_KEY
//});

//Assembly API
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

//import cors for flutter web
import cors from "cors";
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

// ----------------SignUp--Route--------------------

app.post(
  "/signup",
  upload.none(), // since you are not actually uploading 'audio' or 'image' here
  async (req, res) => {
    const { username, password } = req.body;

    console.log("📥 Received:", req.body);

    if (!username || !password) {
      return res.status(400).json({ error: "Username & password are required" });
    }

    try {
      // ✅ Prepare data
      const preferlng = "EN";
      const hash = await bcrypt.hash(password, 12);

      // ✅ Generate emoji via Python
      const prompt = "happy local foodie cartoon emoji";
      const emojiPath = execSync(`python genmoji.py "${prompt}"`).toString().trim();
      console.log("✅ Generated emoji at:", emojiPath);

      // ✅ Upload to Supabase Storage
      const emojiFile = fs.readFileSync(emojiPath);
      const imagePath = `profilepics/${Date.now()}_${username}.png`;

      const { error: uploadError } = await supabase
        .storage
        .from("profilepics")
        .upload(imagePath, emojiFile, { contentType: "image/png" });

      if (uploadError) throw uploadError;

      // ✅ Get public URL
      const { publicUrl: profilepic } = supabase
        .storage
        .from("profilepics")
        .getPublicUrl(imagePath).data;

      console.log("✅ Uploaded to Supabase:", profilepic);

      // ✅ Clean up local file
      await fs.promises.unlink(emojiPath);

      // ✅ Insert into DB
      const { data, error: dbError } = await supabase
        .from("users")
        .insert([{ username, password: hash, profilepic, preferlng }])
        .select();

      if (dbError) {
        console.error("❌ DB Insert error:", dbError);
        return res.status(400).json({ error: dbError.message });
      }

      console.log("🚀 Insert result:", data);

      return res.status(200).json({
        message: "Signup successful",
        user: data[0],
      });

    } catch (err) {
      console.error("Signup error:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }
);



// ----------------Login--Route--------------------

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("username", username)
    .single();

  if (error || !user) {
    return res.status(400).json({ error: "Invalid username or password" });
  }

  const passwordMatches = await bcrypt.compare(password, user.password);

  if (!passwordMatches) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  res.json({ token });
});

// ----------------Spot-Route--------------------
// ✅ Lara Translator SDK Initialization
const LARA_ACCESS_KEY_ID = process.env.LARA_ACCESS_KEY_ID;
const LARA_ACCESS_KEY_SECRET = process.env.LARA_ACCESS_KEY_SECRET;
const credentials = new Credentials(LARA_ACCESS_KEY_ID, LARA_ACCESS_KEY_SECRET);
const lara = new Translator(credentials);

// ✅ Helper function using SDK
const translateText = async (text, targetLang) => {
  try {
    const res = await lara.translate(text, "en-US", targetLang);
    return res.translation;
  } catch (err) {
    console.error(`❌ Lara Translation SDK error for ${targetLang}:`, err.message);
    throw new Error(`Translation to ${targetLang} failed.`);
  }
};

// ------------------badges-function-----------------
export async function updateBadgesForUser(username, supabase) {
  // 1️⃣ try to fetch the row
  const { data: row, error: selErr } = await supabase
    .from("badges")
    .select("scores")          // only need the counter
    .eq("username", username)
    .maybeSingle();            // returns null if not found

  if (selErr) throw selErr;

  if (row) {
    // 2a️⃣ already exists → increment
    const { data, error } = await supabase
      .from("badges")
      .update({ scores: row.scores + 1 })
      .eq("username", username)
      .select("scores")        // get new value back

    if (error) throw error;
    return data[0].scores;

  } else {
    // 2b️⃣ no record yet → insert
    const { data, error } = await supabase
      .from("badges")
      .insert({ username, scores: 1 })
      .select("scores")
      .single();

    if (error) throw error;
    return data.scores;
  }
}




// ------------------end-badge-function--------------

app.post(
  "/spots",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      if (!req.files?.audio || !req.files?.image) {
        return res.status(400).json({ error: "Audio and image are required." });
      }

      const audioFile = req.files.audio[0];
      const imageFile = req.files.image[0];

      const audioPath = `audio/${Date.now()}_${audioFile.originalname}`;
      const imagePath = `images/${Date.now()}_${imageFile.originalname}`;

      await supabase.storage
        .from("audiofiles")
        .upload(audioPath, audioFile.buffer, {
          contentType: audioFile.mimetype,
        });

      await supabase.storage
        .from("spotimages")
        .upload(imagePath, imageFile.buffer, {
          contentType: imageFile.mimetype,
        });

      const { publicUrl: audio_url } = supabase.storage
        .from("audiofiles")
        .getPublicUrl(audioPath).data;
      const { publicUrl: image } = supabase.storage
        .from("spotimages")
        .getPublicUrl(imagePath).data;

      const { spotname, latitude, longitude } = req.body;
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);

      if (isNaN(lat) || isNaN(lng)) {
        return res.status(400).json({ error: "Latitude and longitude must be numbers" });
      }

      // STEP 1: Transcribe audio
      const whisperForm = new FormData();
      whisperForm.append("audio", audioFile.buffer, {
        filename: "audio.mp3",
        contentType: audioFile.mimetype || "audio/mpeg",
      });

      const whisperRes = await axios.post(
        "http://127.0.0.1:5002/transcribe",
        whisperForm,
        { headers: whisperForm.getHeaders() }
      );

      const transcription = whisperRes.data.text?.trim() || "";
      console.log("📝 Transcription:", transcription);

      // STEP 2: Translate to multiple languages using Lara SDK
      const translatedCaptions = {
        fr: await translateText(transcription, "fr-FR"),
        de: await translateText(transcription, "de-DE"),
        hi: await translateText(transcription, "hi-IN"),
      };

      const summary = "Quick summary: " + transcription.split(" ").slice(0, 6).join(" ") + "...";

      // STEP 3: Insert into Supabase
      const insertPayload = {
        spotname: spotname?.trim() || "Unnamed Spot",
        latitude: lat,
        longitude: lng,
        original_language: "en",
        audio_url,
        image,
        caption: transcription,
        transcription,
        translated_captions: translatedCaptions,
        summary,
        likes_count: 0,
      };

      const { data, error } = await supabase
        .from("spots")
        .insert([insertPayload])
        .select()
        .single();

      if (error) {
        return res.status(400).json({
          error: {
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
          },
        });
      }

      res.status(201).json(data);
    } catch (err) {
      console.error("❌ Spot Upload Error:", err.message);
      res.status(500).json({ error: err.message });
    }

    // ------------------------------------

    try {
      const { username } = req.body;
      if (!username) return res.status(400).json({ error: "username required" });

      const newCount = await updateBadgesForUser(username, supabase);
      res.json({ username, scores: newCount });
    } catch (err) {
      console.error("❌ Badge Update Error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// --------------Audio title suggestion-----------------

app.post("/audiotitle", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Audio file is required." });
    }

    console.log("🎧 Received audio file:", req.file.originalname);

    // 1️⃣ Upload audio file to AssemblyAI's upload endpoint
    console.log("⬆️ Uploading to AssemblyAI...");
    const uploadRes = await axios.post(
      "https://api.assemblyai.com/v2/upload",
      req.file.buffer,
      {
        headers: {
          authorization: ASSEMBLYAI_API_KEY,
          "content-type": "application/octet-stream",
        },
      }
    );

    const audioUrl = uploadRes.data.upload_url;
    console.log("✅ Uploaded. Audio URL:", audioUrl);

    // 2️⃣ Start transcription request with auto_chapters (for title / summary)
    console.log("📝 Starting transcription...");
    const transcriptRes = await axios.post(
      "https://api.assemblyai.com/v2/transcript",
      {
        audio_url: audioUrl,
        auto_chapters: true, // enables title / summary generation
      },
      {
        headers: {
          authorization: ASSEMBLYAI_API_KEY,
          "content-type": "application/json",
        },
      }
    );

    const transcriptId = transcriptRes.data.id;
    console.log("🚀 Transcription job started. ID:", transcriptId);

    // 3️⃣ Poll for completion
    let transcript;
    while (true) {
      const pollRes = await axios.get(
        `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
        {
          headers: { authorization: ASSEMBLYAI_API_KEY },
        }
      );

      if (pollRes.data.status === "completed") {
        transcript = pollRes.data;
        console.log("✅ Transcription completed.");
        break;
      } else if (pollRes.data.status === "error") {
        console.error("❌ Transcription failed:", pollRes.data.error);
        return res.status(500).json({ error: "Transcription failed", details: pollRes.data.error });
      }

      console.log("⏳ Waiting for transcription to complete...");
      await new Promise(resolve => setTimeout(resolve, 3000)); // wait 3s
    }

    // 4️⃣ Build your response
    const text = transcript.text;
    let title = "No title generated";
    let summary = "No summary available";

    if (transcript.chapters && transcript.chapters.length > 0) {
      title = transcript.chapters[0].headline || title;
      summary = transcript.chapters[0].summary || summary;
    }

    res.json({
      transcription: text,
      title,
      summary
    });

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});



// ------------------------------------------------------------------------

// ----------------spot intro-------------------------


app.get("/spotintro", async (req, res) => {
  const { username, lat, lon } = req.query;

  if (!username || !lat || !lon) {
    return res.status(400).json({
      error: "username, lat, and lon query parameters are required"
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({
      error: "lat and lon must be valid numbers"
    });
  }

  try {
    const { data: spot, error } = await supabase
      .from("spots")
      .select("category, description, viewcount")
      .eq("username", username)
      .eq("latitude", latitude)
      .eq("longitude", longitude)
      .single();

    if (error || !spot) {
      console.error("❌ Spot fetch error:", error?.message || "Spot not found");
      return res.status(404).json({ error: "Spot not found" });
    }

    return res.status(200).json({
      username,
      latitude,
      longitude,
      category: spot.category,
      description: spot.description,
      viewcount: spot.viewcount,
    });
  } catch (err) {
    console.error("❌ Internal Server Error:", err.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ----------------full spot-------------------------

app.get("/fullspot", async (req, res) => {
  // const { username, lat, lon } = req.query;
  const username = "user4"
  const lat = 12.968120
  const lon = 80.138763

  if (!username || !lat || !lon) {
    return res.status(400).json({
      error: "username, lat, and lon query parameters are required"
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({
      error: "lat and lon must be valid numbers"
    });
  }

  try {
    const { data: spot, error } = await supabase
      .from("spots")
      .select("image, audio_url")
      .eq("username", username)
      .eq("latitude", latitude)
      .eq("longitude", longitude)
      .single();

    if (error || !spot) {
      console.error("❌ Spot fetch error:", error?.message || "Spot not found");
      return res.status(404).json({ error: "Spot not found" });
    }
    console.log(spot.audio_url)


    return res.status(200).json({
      username,
      latitude,
      longitude,
      image: spot.image,
      audio: spot.audio_url,
    });
  } catch (err) {
    console.error("❌ Internal Server Error:", err.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ----------------translation-------------------------

app.get("/translation", async (req, res) => {
  const { username, lat, lon, lang } = req.query;

  if (!username || !lat || !lon || !lang) {
    return res.status(400).json({
      error: "username, lat, lon, and lang query parameters are required"
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({
      error: "lat and lon must be valid numbers"
    });
  }

  try {
    const { data: spot, error } = await supabase
      .from("spots")
      .select("translated_captions")
      .eq("username", username)
      .eq("latitude", latitude)
      .eq("longitude", longitude)
      .single();

    if (error || !spot) {
      console.error("❌ Spot fetch error:", error?.message || "Spot not found");
      return res.status(404).json({ error: "Spot not found" });
    }

    const translation = spot.translated_captions?.[lang];

    if (!translation) {
      console.warn(`⚠️ Translation for language '${lang}' not found`);
      return res.status(404).json({
        error: `Translation for language '${lang}' not found`
      });
    }

    return res.status(200).json({
      username,
      latitude,
      longitude,
      language: lang,
      translation
    });
  } catch (err) {
    console.error("❌ Internal Server Error:", err.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ----------------return summary-------------------------

app.get("/returnsummary", async (req, res) => {
  const { username, lat, lon } = req.query;

  if (!username || !lat || !lon) {
    return res.status(400).json({
      error: "username, lat, and lon query parameters are required"
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({
      error: "lat and lon must be valid numbers"
    });
  }

  try {
    const { data: spot, error } = await supabase
      .from("spots")
      .select("summary")
      .eq("username", username)
      .eq("latitude", latitude)
      .eq("longitude", longitude)
      .single();

    if (error || !spot) {
      console.error("❌ Spot fetch error:", error?.message || "Spot not found");
      return res.status(404).json({ error: "Spot not found" });
    }

    return res.status(200).json({
      username,
      latitude,
      longitude,
      summary: spot.summary
    });
  } catch (err) {
    console.error("❌ Internal Server Error:", err.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});







// ----------------Badges-Update-Route--------------------

app.post("/badges-update", (req, res) => {


});

// -----------------END_POST_REQUEST--------------------


const EARTH_RADIUS = 6_371_000;            // metres
const toRad = deg => (deg * Math.PI) / 180;

/**
 * Returns distance **in metres** between two points
 */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}



// ----------------GET-REQUESTS-------------------------

app.get("/nearby", async (req, res) => {
  /* 1️⃣  read query params */
  const userLat = Number(req.body.lat);
  const userLng = Number(req.body.lng);

  if (Number.isNaN(userLat) || Number.isNaN(userLng)) {
    return res.status(400).json({ error: "lat & lng query params are required numbers" });
  }

  /* 2️⃣  fetch the data you need */
  const { data: spots, error } = await supabase
    .from("spots")
    .select("spotname, latitude, longitude, category");

  if (error) return res.status(500).json({ error: error.message });

  /* 3️⃣  compute distance + filter ≤3 km + sort */
  const result = spots
    .map(s => ({
      ...s,
      distance: distanceMeters(userLat, userLng, s.latitude, s.longitude)
    }))
    .filter(s => s.distance <= 3000)             // within 3 km
    .sort((a, b) => a.distance - b.distance)     // nearest first




  res.json(result);
});






// ----------------Server-Kick-Start--------------------

app.listen(process.env.PORT, () =>
  console.log(`API ready → http://localhost:${process.env.PORT}`)
);