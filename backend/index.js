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
import OpenAI from "openai";
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
let globalSummary = null;

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

app.post(
  "/spots",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      console.log("🧾 Incoming spot upload...");
      console.log("📂 Uploaded files:", req.files);
      console.log("📝 Fields:", req.body);

      if (!req.files?.audio || !req.files?.image) {
        console.log("❌ Missing audio or image file:", req.files);
        return res.status(400).json({ error: "Audio and image are required." });
      }

      const audioFile = req.files.audio[0];
      const imageFile = req.files.image[0];

      const audioPath = `audio/${Date.now()}_${audioFile.originalname}`;
      const imagePath = `images/${Date.now()}_${imageFile.originalname}`;

      let audioUploadRes, imageUploadRes;

      try {
        audioUploadRes = await supabase.storage
          .from("audiofiles")
          .upload(audioPath, audioFile.buffer, {
            contentType: audioFile.mimetype,
          });
        console.log("✅ Audio uploaded:", audioUploadRes);
      } catch (err) {
        console.error("❌ Audio upload failed:", err.message);
        return res.status(500).json({ error: "Audio upload failed", details: err.message });
      }

      try {
        imageUploadRes = await supabase.storage
          .from("spotimages")
          .upload(imagePath, imageFile.buffer, {
            contentType: imageFile.mimetype,
          });
        console.log("✅ Image uploaded:", imageUploadRes);
      } catch (err) {
        console.error("❌ Image upload failed:", err.message);
        return res.status(500).json({ error: "Image upload failed", details: err.message });
      }

      const { publicUrl: audio_url } = supabase.storage
        .from("audiofiles")
        .getPublicUrl(audioPath).data;

      const { publicUrl: image } = supabase.storage
        .from("spotimages")
        .getPublicUrl(imagePath).data;

      const { spotname, category, description, latitude, longitude } = req.body;
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);

      if (isNaN(lat) || isNaN(lng)) {
        return res.status(400).json({ error: "Latitude and longitude must be numbers" });
      }

      // STEP 1: Transcribe audio using Whisper
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
      const detectedLang = whisperRes.data.language || "en";
      console.log("📝 Transcription:", transcription);
      console.log("🌐 Detected Language:", detectedLang);

      // 📴 TEMPORARILY DISABLED TRANSLATION (re-enable when ready)
      
     let transcriptionInEnglish = transcription;
      if (detectedLang !== "en") {
        transcriptionInEnglish = await translateText(transcription, "en");
      }

      // STEP 3: Translate into other languages
      const translatedCaptions = {
        en: transcriptionInEnglish,
        fr: detectedLang === "fr" ? transcription : await translateText(transcription, "fr-FR"),
        de: detectedLang === "de" ? transcription : await translateText(transcription, "de-DE"),
        hi: detectedLang === "hi" ? transcription : await translateText(transcription, "hi-IN"),
      };


      // STEP 2: Use summary from earlier step
      const summary = globalSummary || "No summary available.";
      globalSummary = null;

      // STEP 3: Insert into Supabase
      const insertPayload = {
        spotname: spotname?.trim() || "Unnamed Spot",
        category: category?.trim() || "General",
        description: description?.trim() || "",
        latitude: lat,
        longitude: lng,
        original_language: detectedLang,
        audio_url,
        image,
        caption: transcription,
        transcription: transcription, // fallback
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
        console.error("❌ DB Insert Error:", error);
        return res.status(400).json({
          error: {
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
          },
        });
      }

      console.log("✅ Spot uploaded successfully:", data);
      res.status(201).json(data);
    } catch (err) {
      console.error("❌ Spot Upload Error:", err.message);
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

    // 1️⃣ Upload to AssemblyAI
    console.log("⬆️ Uploading to AssemblyAI...");
    const uploadRes = await axios.post(
      "https://api.assemblyai.com/v2/upload",
      req.file.buffer,
      {
        headers: {
          authorization: process.env.ASSEMBLYAI_API_KEY,
          "content-type": "application/octet-stream",
        },
      }
    );

    const audioUrl = uploadRes.data.upload_url;
    console.log("✅ Uploaded. Audio URL:", audioUrl);

    // 2️⃣ Start transcription with auto_chapters
    console.log("📝 Starting transcription...");
    const transcriptRes = await axios.post(
      "https://api.assemblyai.com/v2/transcript",
      {
        audio_url: audioUrl,
        auto_chapters: true,
      },
      {
        headers: {
          authorization: process.env.ASSEMBLYAI_API_KEY,
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
          headers: { authorization: process.env.ASSEMBLYAI_API_KEY },
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

  
    // 4️⃣ Extract title and build 2-line description
    const title = transcript.chapters?.[0]?.headline || "No title generated";

    let description = transcript.chapters?.[0]?.summary || "No short description available";

    const summary = transcript.summary || description;
    globalSummary = summary;
    console.log(globalSummary);

  // ✂️ Trim to only first 2 sentences
     const sentences = description.split('.').filter(Boolean);
     description = sentences.slice(0, 2).join('. ').trim();
     if (description && !description.endsWith('.')) {
     description += '.';
    }

    res.json({
      title,
      description
    });

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});

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


// ----------------Badges-Update-Route--------------------

app.post("/badges-update", (req, res) => {});

// ----------------Audio-Upload-Route--------------------

// ----------------Server-Kick-Start--------------------

app.listen(process.env.PORT, () =>
  console.log(`API ready → http://localhost:${process.env.PORT}`)
);
