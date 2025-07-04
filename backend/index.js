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

import Anime_Test from "./"


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

app.post(
  "/spots",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      /* 1. basic validation */
      if (!req.files?.audio || !req.files?.image)
        return res.status(400).json({ error: "audio and image required" });

      /* 2. upload files to Storage buckets */
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

      /* 3. get public URLs (bucket must be public) */
      const { publicUrl: audio_url } = supabase.storage
        .from("audiofiles")
        .getPublicUrl(audioPath).data;
      const { publicUrl: image } = supabase.storage
        .from("spotimages")
        .getPublicUrl(imagePath).data;

      /* 4. insert row into spots table */
      const { spotname, latitude, longitude, caption = "" } = req.body;
      const { data, error } = await supabase
        .from("spots")
        .insert([
          {
            spotname,
            latitude: Number(latitude),
            longitude: Number(longitude),
            caption,
            original_language: "EN",
            audio_url,
            image,
            likes_count: 0,
          },
        ])
        .select()
        .single();

      if (error) throw error;
      res.status(201).json(data);
    } catch (err) {
      console.error(err);
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
