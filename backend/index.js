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
import { Credentials, Translator } from "@translated/lara";


dotenv.config();

const app = express();
app.use(express.json());

//import cors for flutter web
import cors from "cors";
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

// ----------------SignUp--Route--------------------

app.post(
  "/signup",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  async (req, res) => {
    const { username, password } = req.body;

    try {
      // Call the Python emoji generation server
      // const emojiResponse = await axios.get(
      //   "http://localhost:5000/generate-emoji",
      //   {
      //     params: { prompt: "cat Woman" },
      //   }
      // );
      const emojiPath = "";
      console.log(emojiPath);

      // Upload to Supabase storage
      const emojiFile = fs.readFileSync(emojiPath);
      const imagePath = `profilepics/${Date.now()}_${username}.png`;
      const { error: uploadError } = await supabase
        .from("profilepics")
        .upload(imagePath, emojiFile, {
          contentType: "image/png",
        });

      if (uploadError) throw uploadError;

      // Get public URL
      const { publicUrl: profilepic } = supabase.storage
        .from("profilepics")
        .getPublicUrl(imagePath).data;

      // Delete the temporary file
      await fs.promises.unlink(emojiPath);

      // Create user with the generated emoji
      const preferlng = "EN";
      const hash = await bcrypt.hash(password, 12);
      const { data, error } = await supabase
        .from("users")
        .insert([{ username, password: hash, profilepic, preferlng }])
        .select();

      if (error) return res.status(400).json({ error: error.message });
      res.json(data[0]);
    } catch (error) {
      console.error("Signup error:", error);
      res.status(500).json({ error: "Failed to generate profile picture" });
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
  }
);








// ----------------Badges-Update-Route--------------------

app.post("/badges-update", (req, res) => {});

// ----------------Audio-Upload-Route--------------------

// ----------------Server-Kick-Start--------------------

app.listen(process.env.PORT, () =>
  console.log(`API ready → http://localhost:${process.env.PORT}`)
);
