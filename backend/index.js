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
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegPath.path);

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

const convertAACtoMP3 = (buffer) =>
  new Promise((resolve, reject) => {
    const tempDir = os.tmpdir(); // Cross-platform temp directory
    const tempInput = path.join(tempDir, `temp_${Date.now()}.aac`);
    const tempOutput = path.join(tempDir, `temp_${Date.now()}.mp3`);

    try {
      fs.writeFileSync(tempInput, buffer);
    } catch (err) {
      console.error("❌ Failed to write temp .aac file:", err);
      return reject(err);
    }

    ffmpeg(tempInput)
      .setFfmpegPath(ffmpegPath.path)
      .toFormat("mp3")
      .on("error", (err) => {
        console.error("❌ FFmpeg conversion failed:", err.message);
        reject(err);
      })
      .on("end", () => {
        try {
          const mp3Buffer = fs.readFileSync(tempOutput);
          fs.unlinkSync(tempInput);
          fs.unlinkSync(tempOutput);
          resolve(mp3Buffer);
        } catch (readErr) {
          console.error("❌ Failed to read or clean up files:", readErr);
          reject(readErr);
        }
      })
      .save(tempOutput);
  });

// ----------------SignUp--Route--------------------

app.post(
  "/signup",
  upload.none(), // since you are not actually uploading 'audio' or 'image' here
  async (req, res) => {
    const { username, password } = req.body;

    console.log("📥 Received:", req.body);

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Username & password are required" });
    }

    try {
      // ✅ Prepare data
      const preferlng = "EN";
      const hash = await bcrypt.hash(password, 12);

      // ✅ Generate emoji via Python
      const prompt = "emoji cat boy";
      const emojiPath = execSync(`python genmoji.py "${prompt}"`)
        .toString()
        .trim();
      console.log("✅ Generated emoji at:", emojiPath);

      // ✅ Upload to Supabase Storage
      const emojiFile = fs.readFileSync(emojiPath);
      const imagePath = `profilepics/${Date.now()}_${username}.png`;

      const { error: uploadError } = await supabase.storage
        .from("profilepics")
        .upload(imagePath, emojiFile, { contentType: "image/png" });

      if (uploadError) throw uploadError;

      // ✅ Get public URL
      const { publicUrl: profilepic } = supabase.storage
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
    console.error(
      `❌ Lara Translation SDK error for ${targetLang}:`,
      err.message
    );
    throw new Error(`Translation to ${targetLang} failed.`);
  }
};

// ------------------badges-function-----------------
export async function updateBadgesForUser(username, supabase) {
  // 1️⃣ try to fetch the row
  const { data: row, error: selErr } = await supabase
    .from("badges")
    .select("scores") // only need the counter
    .eq("username", username)
    .maybeSingle(); // returns null if not found

  if (selErr) throw selErr;

  if (row) {
    // 2a️⃣ already exists → increment
    const { data, error } = await supabase
      .from("badges")
      .update({ scores: row.scores + 5 })
      .eq("username", username)
      .select("scores"); // get new value back

    if (error) throw error;
    return data[0].scores;
  } else {
    // 2b️⃣ no record yet → insert
    const { data, error } = await supabase
      .from("badges")
      .insert({ username, scores: 5 })
      .select("scores")
      .single();

    if (error) throw error;
    return data.scores;
  }
}
export async function updatePostCountForUser(username, supabase) {
  // 1️⃣ Count how many spots this user has posted
  const { count, error: countErr } = await supabase
    .from("spots")
    .select("*", { count: "exact", head: true }) // just count, don't fetch rows
    .eq("username", username);

  if (countErr) throw countErr;

  // 2️⃣ Update the user's postCount
  const { data, error: updateErr } = await supabase
    .from("users")
    .update({ postcount: count })
    .eq("username", username)
    .select("postcount")
    .single();

  if (updateErr) throw updateErr;

  return data.postCount;
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

      const { username, spotname, latitude, longitude } = req.body;
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);

      if (isNaN(lat) || isNaN(lng)) {
        return res
          .status(400)
          .json({ error: "Latitude and longitude must be numbers" });
      }

      // // Transcribe
      const convertedBuffer = await convertAACtoMP3(audioFile.buffer);

      const whisperForm = new FormData();
      whisperForm.append("audio", convertedBuffer, {
        filename: "audio.mp3",
        contentType: "audio/mpeg",
      });

      const whisperRes = await axios.post(
        "http://127.0.0.1:5002/transcribe",
        whisperForm,
        { headers: whisperForm.getHeaders() }
      );

      const transcription = whisperRes.data.text?.trim() || "";
      console.log("📝 Transcription:", transcription);

      const translatedCaptions = {
        fr: await translateText(transcription, "fr-FR"),
        de: await translateText(transcription, "de-DE"),
        hi: await translateText(transcription, "hi-IN"),
      };

      const summary =
        "Quick summary: " +
        transcription.split(" ").slice(0, 6).join(" ") +
        "...";

      const insertPayload = {
        username,
        spotname: spotname?.trim() || "Unnamed Spot",
        latitude: lat,
        longitude: lng,
        original_language: "en",
        audio_url,
        image,
        viewcount: 0,
        category: "Food",
        description: "More",
        created_at: new Date().toISOString(),
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

      // 🏅 Badge + post count update before sending response
      const newCount = await updateBadgesForUser(username, supabase);
      const postCount = await updatePostCountForUser(username, supabase);

      // ✅ Send single response
      res.status(201).json({
        spot: data,
        badges: newCount,
        postCount,
      });
    } catch (err) {
      console.error("❌ Spot Upload Error:", err);
      res
        .status(500)
        .json({ error: err.message, details: err.response?.data || err.stack });
    }
  }
);

// ----dummy-route-------

// app.post(
//   "/spots",
//   upload.fields([
//     { name: "audio", maxCount: 1 },
//     { name: "image", maxCount: 1 },
//   ]),
//   async (req, res) => {
//     try {
//       if (!req.files?.audio || !req.files?.image) {
//         return res.status(400).json({ error: "Audio and image are required." });
//       }

//       const audioFile = req.files.audio[0];
//       const imageFile = req.files.image[0];

//       const audioPath = `audio/${Date.now()}_${audioFile.originalname}`;
//       const imagePath = `images/${Date.now()}_${imageFile.originalname}`;

//       // Upload audio to Supabase Storage
//       await supabase.storage
//         .from("audiofiles")
//         .upload(audioPath, audioFile.buffer, {
//           contentType: audioFile.mimetype,
//         });

//       // Upload image to Supabase Storage
//       await supabase.storage
//         .from("spotimages")
//         .upload(imagePath, imageFile.buffer, {
//           contentType: imageFile.mimetype,
//         });

//       // Get public URLs
//       const { publicUrl: audio_url } = supabase.storage
//         .from("audiofiles")
//         .getPublicUrl(audioPath).data;
//       const { publicUrl: image } = supabase.storage
//         .from("spotimages")
//         .getPublicUrl(imagePath).data;

//       // Extract form data
//       const {
//         username,
//         spotname,
//         latitude,
//         longitude,
//         caption,
//         transcription,
//         translated_captions,
//         summary,
//         category = "History Whishpers",
//         description = "More",
//         original_language = "en",
//       } = req.body;

//       const lat = parseFloat(latitude);
//       const lng = parseFloat(longitude);

//       if (isNaN(lat) || isNaN(lng)) {
//         return res.status(400).json({ error: "Latitude and longitude must be numbers" });
//       }

//       const insertPayload = {
//         username,
//         spotname: spotname?.trim() || "Unnamed Spot",
//         latitude: lat,
//         longitude: lng,
//         original_language,
//         audio_url,
//         image,
//         viewcount: 0,
//         category,
//         description,
//         created_at: new Date().toISOString(),
//         caption: caption || transcription || "",
//         transcription: transcription || "",
//         translated_captions: JSON.parse(translated_captions || "{}"),
//         summary: summary || "",
//         likes_count: 0,
//       };

//       const { data, error } = await supabase
//         .from("spots")
//         .insert([insertPayload])
//         .select()
//         .single();

//       if (error) {
//         return res.status(400).json({
//           error: {
//             message: error.message,
//             details: error.details,
//             hint: error.hint,
//             code: error.code,
//           },
//         });
//       }

//       res.status(201).json(data);
//     } catch (err) {
//       console.error("❌ Spot Upload Error:", err.message);
//       res.status(500).json({ error: err.message });
//     }
//   }
// );

// ------end--dummy---route---------------------------

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
        return res
          .status(500)
          .json({ error: "Transcription failed", details: pollRes.data.error });
      }

      console.log("⏳ Waiting for transcription to complete...");
      await new Promise((resolve) => setTimeout(resolve, 3000)); // wait 3s
    }

    // 4️⃣ Extract title and build 2-line description
    const title = transcript.chapters?.[0]?.headline || "No title generated";

    let description =
      transcript.chapters?.[0]?.summary || "No short description available";

    // ✂️ Trim to only first 2 sentences
    const sentences = description.split(".").filter(Boolean);
    description = sentences.slice(0, 2).join(". ").trim();
    if (description && !description.endsWith(".")) {
      description += ".";
    }

    res.json({
      title,
      description,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: err.message });
  }
});

// ------------------------------------------------------------------------

// ----------------spot intro-------------------------

app.get("/spotintro", async (req, res) => {
  const { username, lat, lon } = req.query;

  console.log("📥 Incoming request to /spotintro with query:", {
    username,
    lat,
    lon,
  });

  if (!username || !lat || !lon) {
    console.warn("⚠️ Missing query parameters");
    return res.status(400).json({
      error: "username, lat, and lon query parameters are required",
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    console.warn("⚠️ Invalid latitude or longitude format", { lat, lon });
    return res.status(400).json({
      error: "lat and lon must be valid numbers",
    });
  }

  console.log("🔍 Querying Supabase for spot with:");
  console.log(`   Username: ${username}`);
  console.log(
    `   Latitude range: [${latitude - 0.000001}, ${latitude + 0.000001}]`
  );
  console.log(
    `   Longitude range: [${longitude - 0.000001}, ${longitude + 0.000001}]`
  );

  try {
    const { data: spots, error } = await supabase
      .from("spots")
      .select("spotname, category, description, viewcount")
      .eq("username", username)
      .gte("latitude", latitude - 0.000001)
      .lte("latitude", latitude + 0.000001)
      .gte("longitude", longitude - 0.000001)
      .lte("longitude", longitude + 0.000001);

    if (error) {
      console.error("❌ Supabase error:", error.message);
      return res.status(500).json({ error: "Database error" });
    }

    console.log(`✅ Supabase returned ${spots.length} result(s)`);

    if (!spots || spots.length === 0) {
      console.warn("⚠️ No spot found matching the location and username", {
        username,
        latitude,
        longitude,
      });
      return res.status(404).json({ error: "Spot not found" });
    }

    const spot = spots[0];

    console.log("📤 Sending spot data:", {
      username,
      latitude,
      longitude,
      category: spot.category,
      description: spot.description,
      viewcount: spot.viewcount,
      spotname: spot.spotname,
    });

    return res.status(200).json({
      username,
      latitude,
      longitude,
      category: spot.category,
      description: spot.description,
      viewcount: spot.viewcount,
      spotname: spot.spotname,
    });
  } catch (err) {
    console.error("❌ Internal Server Error:", err.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ----------------full spot-------------------------

// ------------------View-Count--Function--------------------
export async function ViewCount(lat, lon) {
  try {
    const range = 0.00001;
    console.log("🔍 ViewCount called with:", { lat, lon });

    const { data: allMatches, error: matchError } = await supabase
      .from("spots")
      .select("id, viewcount")
      .gte("latitude", lat - range)
      .lte("latitude", lat + range)
      .gte("longitude", lon - range)
      .lte("longitude", lon + range);

    if (matchError) {
      console.error("❌ Error fetching matching spots:", matchError.message);
      return;
    }

    console.log(
      `📊 Found ${allMatches?.length} matching spot(s) for viewcount`
    );

    if (!allMatches || allMatches.length === 0) {
      console.warn(
        "⚠️ No spot found for given lat/lon to increment view count"
      );
      return;
    }

    const spot = allMatches[0];
    const newViewCount = (spot.viewcount || 0) + 1;

    const { data: updatedSpot, error: updateErr } = await supabase
      .from("spots")
      .update({ viewcount: newViewCount })
      .eq("id", spot.id)
      .select("viewcount")
      .maybeSingle();

    if (updateErr) {
      console.error("❌ Failed to update viewcount:", updateErr.message);
      return;
    }

    console.log(
      `✅ Viewcount updated to ${updatedSpot.viewcount} for spot ID ${spot.id}`
    );
  } catch (error) {
    console.error("❌ ViewCount unexpected error:", error.message);
  }
}

app.get("/fullspot", async (req, res) => {
  const { username, lat, lon } = req.query;

  console.log("📥 Incoming /fullspot request:", { username, lat, lon });

  if (!username || !lat || !lon) {
    return res.status(400).json({
      error: "username, lat, and lon query parameters are required",
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({
      error: "lat and lon must be valid numbers",
    });
  }

  try {
    await ViewCount(latitude, longitude);

    const range = 0.00001;

    const { data: spot, error } = await supabase
      .from("spots")
      .select("id, spotname, image, audio_url, transcription")
      .eq("username", username)
      .gte("latitude", latitude - range)
      .lte("latitude", latitude + range)
      .gte("longitude", longitude - range)
      .lte("longitude", longitude + range)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("❌ Supabase error while fetching spot:", error.message);
      return res.status(500).json({ error: "Database error" });
    }

    if (!spot) {
      console.warn("❌ No spot found matching given username and location", {
        username,
        latitude,
        longitude,
      });
      return res.status(404).json({ error: "Spot not found" });
    }

    console.log("✅ Spot found:", {
      id: spot.id,
      name: spot.spotname,
      audio: spot.audio_url,
    });

    return res.status(200).json({
      id: spot.id,
      username,
      latitude,
      longitude,
      image: spot.image,
      audio: spot.audio_url,
      spotname: spot.spotname,
      script: spot.transcription,
    });
  } catch (err) {
    console.error("❌ Internal Server Error:", err.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ----------------translation-------------------------

app.get("/translation", async (req, res) => {
  const { username, lat, lon, lang } = req.query;

  console.log("🔎 Incoming Query Params:", { username, lat, lon, lang });

  if (!username || !lat || !lon || !lang) {
    console.warn("⚠️ Missing required query parameters");
    return res.status(400).json({
      error: "username, lat, lon, and lang query parameters are required",
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  console.log(`📌 Parsed lat/lon: ${latitude}, ${longitude}`);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    console.error("❌ Invalid lat/lon values");
    return res.status(400).json({
      error: "lat and lon must be valid numbers",
    });
  }

  // 🌐 Map language name to language code
  const langMap = {
    english: "en",
    french: "fr",
    hindi: "hi",
    german: "de",
  };

  const langCode = langMap[lang.toLowerCase()];
  if (!langCode) {
    console.warn(`⚠️ Unsupported language requested: ${lang}`);
    return res.status(400).json({ error: `Unsupported language: ${lang}` });
  }

  console.log(`🌐 Mapped language '${lang}' to code '${langCode}'`);

  try {
    console.log("📡 Querying Supabase...");

    const { data: spot, error } = await supabase
      .from("spots")
      .select("translated_captions, username, latitude, longitude")
      .eq("username", username)
      // 🔥 Add small tolerance for floating-point comparison
      .gte("latitude", latitude - 0.00001)
      .lte("latitude", latitude + 0.00001)
      .gte("longitude", longitude - 0.00001)
      .lte("longitude", longitude + 0.00001)
      .maybeSingle(); // ✅ safer than .single()

    console.log("📦 Supabase Query Result:", spot);

    if (error) {
      console.error("❌ Supabase Query Error:", error.message);
      return res.status(500).json({ error: "Supabase query failed" });
    }

    if (!spot) {
      console.warn("⚠️ No spot found for given username/lat/lon");
      return res.status(404).json({ error: "Spot not found" });
    }

    const translation = spot.translated_captions?.[langCode];

    if (!translation) {
      console.warn(`⚠️ Translation for language '${langCode}' not found`);
      return res.status(404).json({
        error: `Translation for language '${langCode}' not found`,
      });
    }

    console.log("✅ Translation found:", translation);

    return res.status(200).json({
      username: spot.username,
      latitude: spot.latitude,
      longitude: spot.longitude,
      language: langCode,
      translation,
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
      error: "username, lat, and lon query parameters are required",
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({
      error: "lat and lon must be valid numbers",
    });
  }

  try {
    const { data: spots, error } = await supabase
      .from("spots")
      .select("spotname, description, summary")
      .eq("username", username)
      .gte("latitude", latitude - 0.000001)
      .lte("latitude", latitude + 0.000001)
      .gte("longitude", longitude - 0.000001)
      .lte("longitude", longitude + 0.000001);

    if (error) {
      console.error("❌ Supabase error:", error.message);
      return res.status(500).json({ error: "Database error" });
    }

    if (!spots || spots.length === 0) {
      console.error("❌ No spot found for query:", {
        username,
        latitude,
        longitude,
      });
      return res.status(404).json({ error: "Spot not found" });
    }

    const spot = spots[0];

    return res.status(200).json({
      username,
      latitude,
      longitude,
      spotname: spot.spotname,
      description: spot.description,
      summary: spot.summary,
    });
  } catch (err) {
    console.error("❌ Internal Server Error:", err.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ----------------Badges-Update-Route--------------------

app.post("/badges-update", (req, res) => {});

// -----------------END_POST_REQUEST--------------------

const EARTH_RADIUS = 6_371_000; // metres
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Returns distance **in metres** between two points
 */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}

// ----------------GET-REQUESTS-------------------------

app.get("/nearby", async (req, res) => {
  const userLat = Number(req.query.lat); // ← fixed
  const userLng = Number(req.query.lng); // ← fixed
  const SelectedCategory = req.query.SearchQuery;
  // const { lat,lng, SearchCategry} = req.body;
  // const userLat = lat
  // const userLng = lng
  // const SelectedCategory = SearchCategry;

  if (Number.isNaN(userLat) || Number.isNaN(userLng)) {
    return res
      .status(400)
      .json({ error: "lat & lng query params are required numbers" });
  }

  const { data: spots, error } = await supabase
    .from("spots")
    .select("spotname, latitude, longitude, category, username"); // 👈 include username

  if (error) return res.status(500).json({ error: error.message });

  const result = spots
    .map((s) => ({
      ...s,
      distance: distanceMeters(userLat, userLng, s.latitude, s.longitude),
    }))
    .filter((s) => s.distance <= 7000 && s.category === SelectedCategory)
    .sort((a, b) => a.distance - b.distance);
  // console.log(result);

  res.json(result);
});

// ----------------Profile-Return-------------------------
app.post("/return-profile", async (req, res) => {
  const { username } = req.body;

  console.log("🛠 Incoming username:", username);

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  const cleanUsername = username.trim().toLowerCase();

  try {
    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("postcount, profilepic") // 👈 SELECT profile_image too
      .ilike("username", cleanUsername)
      .single();

    console.log("🧩 Supabase user result:", user);
    console.log("🧩 Supabase error:", userErr);

    if (userErr || !user) {
      return res.status(404).json({ error: "User not found" });
    }

    const { data: spots, error: spotErr } = await supabase
      .from("spots")
      .select("id, image, spotname, viewcount, likes_count")
      .ilike("username", cleanUsername);

    if (spotErr) {
      return res.status(500).json({ error: "Error fetching spots" });
    }

    const uploaded_spots = spots.map((spot) => ({
      id: spot.id,
      spotimage: spot.image,
      title: spot.spotname,
      viewscount: spot.viewcount,
      likescount: spot.likes_count,
    }));

    const { data: badges, error: badgeErr } = await supabase
      .from("badges")
      .select("scores")
      .ilike("username", cleanUsername)
      .single();

    if (badgeErr) {
      return res.status(500).json({ error: "Error fetching badge" });
    }

    res.json({
      username: cleanUsername,
      profile_image: user.profilepic || null, // 👈 Include it in the response
      postcount: user.postcount || 0,
      score: badges.scores || 0,
      uploaded_spots,
    });
  } catch (err) {
    console.error("❌ Profile fetch error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});
// --------------search-query-----------------

const OPENCAGE_API_KEY = process.env.OPENCAGE_API_KEY;

function getBoundingBox(lat, lon, radiusInKm = 2) {
  const latR = 1 / 110.574;
  const lonR = 1 / (111.32 * Math.cos(lat * (Math.PI / 180)));

  const latDelta = radiusInKm * latR;
  const lonDelta = radiusInKm * lonR;

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  };
}

// Route: /search-spots
app.post("/search-spots", async (req, res) => {
  const { SearchQuery } = req.body;

  if (!SearchQuery) {
    return res.status(400).json({ error: "SearchQuery is required" });
  }

  try {
    // 1. Convert query to lat/lon
    const geoRes = await axios.get(
      "https://api.opencagedata.com/geocode/v1/json",
      {
        params: {
          q: SearchQuery,
          key: OPENCAGE_API_KEY,
        },
      }
    );

    const results = geoRes.data.results;
    if (!results || results.length === 0) {
      return res.status(404).json({ error: "Location not found" });
    }

    const { lat, lng } = results[0].geometry;

    // 2. Calculate bounding box
    const box = getBoundingBox(lat, lng, 2); // 2km radius

    // 3. Query Supabase spots table within bounding box
    const { data, error } = await supabase
      .from("spots")
      .select("*")
      .lte("latitude", box.maxLat)
      .gte("latitude", box.minLat)
      .lte("longitude", box.maxLon)
      .gte("longitude", box.minLon);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({
      location: results[0].formatted,
      total_spots: data.length,
      spots: data,
    });
    console.log("Spots", data);
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// -------------------------delete route----------------------

app.delete("/delete-post", async (req, res) => {
  const id = req.query.id;

  console.log("🧾 Incoming DELETE request to /delete-post");
  console.log("🔍 ID received:", id);

  if (!id) {
    console.warn("⚠️ No ID provided in query params.");
    return res.status(400).json({ error: "ID is required" });
  }

  try {
    console.log("📡 Attempting to delete from 'spot' table where id =", id);

    const { data, error } = await supabase.from("spots").delete().eq("id", id);

    if (error) {
      console.error("❌ Supabase deletion error:", error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log("✅ Spot deleted successfully. Deleted data:", data);
    res.json({ message: "Spot deleted successfully", data });
  } catch (err) {
    console.error("🚨 Server error during deletion:", err.message);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ------------user-post------------------------------------------------------------------------------------------
app.get("/Get-Posts", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  try {
    const { data: posts, error } = await supabase
      .from("spots")
      .select("*")
      .eq("username", username);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// --------------------Set-Home-Location + Area Name Update -----------------------
app.post("/set-home", async (req, res) => {
  try {
    const { username, lat, lon } = req.body;

    if (!username || typeof lat !== "number" || typeof lon !== "number") {
      return res.status(400).json({ error: "Invalid or missing input data." });
    }

    // Fetch user
    const { data: user, error: fetchError } = await supabase
      .from("users")
      .select("latitude, longitude")
      .eq("username", username)
      .single();

    if (fetchError) {
      console.error("Error fetching user:", fetchError.message);
      return res
        .status(500)
        .json({ error: "Database error while checking user." });
    }

    if (!user) {
      return res.status(404).json({ error: `User '${username}' not found.` });
    }

    // Only update if lat/lon is null
    if (user.latitude === null || user.longitude === null) {
      const areaName = await getLocationName(lat, lon);

      if (!areaName) {
        return res
          .status(500)
          .json({ error: "Failed to resolve area name from coordinates." });
      }

      const { error: updateError } = await supabase
        .from("users")
        .update({
          latitude: lat,
          longitude: lon,
          area_name: areaName,
        })
        .eq("username", username);

      if (updateError) {
        console.error("Error updating user location:", updateError.message);
        return res
          .status(500)
          .json({ error: "Failed to update user location." });
      }

      return res
        .status(200)
        .json({ message: "Location and area updated successfully." });
    } else {
      return res.status(200).json({ message: "Location already set." });
    }
  } catch (err) {
    console.error("Unexpected server error in /set-home:", err);
    return res.status(500).json({ error: "Unexpected server error." });
  }
});

// ---------------Area-LeaderBoard----------------------
const getLocationName = async (lat, lon) => {
  const { data } = await axios.get(
    "https://api.opencagedata.com/geocode/v1/json",
    {
      params: {
        key: process.env.OPENCAGE_API_KEY,
        q: `${lat},${lon}`,
      },
    }
  );

  const components = data.results[0]?.components;
  return (
    components?.suburb ||
    components?.neighbourhood ||
    components?.city_district ||
    components?.city
  );
};

// -------------------------------------------
app.post("/area-leaderboard", async (req, res) => {
  try {
    const { lat, lon } = req.body;

    if (!lat || !lon) {
      return res.status(400).json({ error: "lat/lon missing" });
    }

    // Step 1: Convert lat/lon to area name
    const areaName = await getLocationName(lat, lon);
    if (!areaName) {
      return res.status(500).json({ error: "Unable to resolve area name" });
    }

    // Step 2: Get all users in that area
    const { data: usersInArea, error: usersErr } = await supabase
      .from("users")
      .select("username")
      .eq("area_name", areaName);

    if (usersErr) {
      console.error("Error fetching users in area:", usersErr.message);
      return res.status(500).json({ error: "Failed to fetch area users" });
    }

    const usernames = usersInArea.map((user) => user.username);
    if (usernames.length === 0) {
      return res.json({ area: areaName, leaderboard: [] });
    }

    // Step 3: Fetch their scores from badges
    const { data: scores, error: badgeErr } = await supabase
      .from("badges")
      .select("username, scores")
      .in("username", usernames);

    if (badgeErr) {
      console.error("Error fetching badge scores:", badgeErr.message);
      return res.status(500).json({ error: "Failed to fetch scores" });
    }

    // Step 4: Sort by score
    const leaderboard = scores.sort((a, b) => b.scores - a.scores);

    return res.status(200).json({
      area: areaName,
      leaderboard,
    });
  } catch (err) {
    console.error("Unexpected error in /area-leaderboard:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});



// --1----Journey-status--------
app.post("/journey-status", async (req, res) => {
  const { username } = req.body;

  try {
    const { data, error } = await supabase
      .from("users")
      .select("status")
      .eq("username", username)
      .single(); // we expect only one row

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    const status = data?.status;

    // Assuming status is a boolean or can be interpreted as one
    return res.json({ journeyStatus: !!status });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});



// ---2---Start--Journey---------

app.post("/start-journey", async (req, res) => {
  const { username, source, journeyname } = req.body;

  try {
    // 1. Insert journey data
    const { data: journeyData, error: journeyError } = await supabase
      .from("journey")
      .insert([
        {
          username: username,
          source: source,
          destination: null,
          journeyname: journeyname,
          spotpins: null, // ignore for now,
          status: true
        },
      ]);

    if (journeyError) {
      return res
        .status(400)
        .json({ success: false, message: journeyError.message });
    }

    // 2. Update user status to true
    const { data: userData, error: userError } = await supabase
      .from("users")
      .update({ status: true })
      .eq("username", username);

    if (userError) {
      return res
        .status(400)
        .json({ success: false, message: userError.message });
    }

    return res.json({ success: true, message: "Journey started successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ----4--Journey-upload--------
app.post(
  "/journey-upload",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { username, title, latitude, longitude } = req.body;
      const audioFile = req.files?.audio?.[0];
      const imageFile = req.files?.image?.[0];

      if (!username || !audioFile || !imageFile) {
        return res
          .status(400)
          .json({ success: false, message: "Missing required fields" });
      }

      // 1. Check user status
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("status")
        .eq("username", username)
        .single();

      if (userError || !user?.status) {
        return res
          .status(403)
          .json({ success: false, message: "Inactive or missing user" });
      }

      // 2. Get active journey
      const { data: journey, error: journeyFetchError } = await supabase
        .from("journey")
        .select("id, spotpins")
        .eq("username", username)
        .eq("status", true)
        .maybeSingle();

      if (journeyFetchError || !journey) {
        return res
          .status(404)
          .json({ success: false, message: "Active journey not found" });
      }

      const timestamp = Date.now();

      // 3. Upload audio to journeymap/audio/
      const audioPath = `audio/${timestamp}_${audioFile.originalname}`;
      await supabase.storage
        .from("journeymap")
        .upload(audioPath, audioFile.buffer, {
          contentType: audioFile.mimetype,
        });
      const { publicUrl: audio_url } = supabase.storage
        .from("journeymap")
        .getPublicUrl(audioPath).data;

      // 4. Upload image to journeymap/images/
      const imagePath = `images/${timestamp}_${imageFile.originalname}`;
      await supabase.storage
        .from("journeymap")
        .upload(imagePath, imageFile.buffer, {
          contentType: imageFile.mimetype,
        });
      const { publicUrl: image_url } = supabase.storage
        .from("journeymap")
        .getPublicUrl(imagePath).data;

      // 5. Create new spot pin
      const newSpotPin = {
        title: title || "Untitled Spot",
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        audio_url,
        image_url,
        uploaded_at: new Date().toISOString(),
      };

      // 6. Merge and update journey
      const updatedSpotpins = Array.isArray(journey.spotpins)
        ? [...journey.spotpins, newSpotPin]
        : [newSpotPin];

      const { error: updateError } = await supabase
        .from("journey")
        .update({ spotpins: updatedSpotpins })
        .eq("id", journey.id);

      if (updateError) {
        return res
          .status(500)
          .json({ success: false, message: updateError.message });
      }

      return res.json({
        success: true,
        message: "Spot pin added to journey",
        spotpin: newSpotPin,
      });
    } catch (err) {
      console.error("❌ Journey upload error:", err);
      return res.status(500).json({
        success: false,
        message: "Server error",
        error: err.message,
      });
    }
  }
);


// ---5---Journey-pins--------
app.post("/return-journey-pins", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ success: false, message: "Username is required" });
  }

  try {
    // 1. Check if user is active
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("status")
      .eq("username", username)
      .single();

    if (userError || !user || user.status !== true) {
      return res.status(400).json({ success: false, message: "User not active or not found" });
    }

    // 2. Fetch active journey for user
    const { data: journey, error: journeyError } = await supabase
      .from("journey")
      .select("spotpins, source, destination")
      .eq("username", username)
      .eq("status", true)
      .maybeSingle();

    if (journeyError || !journey) {
      return res.status(400).json({ success: false, message: "Active journey not found" });
    }

    // 3. Return the journey data
    return res.json({
      success: true,
      spotpins: journey.spotpins,
      source: journey.source,
      destination: journey.destination,
    });

  } catch (err) {
    console.error("Error fetching journey pins:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/end-journey", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ success: false, message: "Username required" });
  }

  try {
    // 1. Validate user is active
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("status")
      .eq("username", username)
      .single();

    if (userError || !user || user.status != true) {
      return res.status(403).json({ success: false, message: "User is not active or not found" });
    }

    // 2. Fetch active journey for the user
    const { data: journey, error: journeyError } = await supabase
      .from("journey")
      .select("id, spotpins")
      .eq("username", username)
      .eq("status", true)
      .maybeSingle();

    if (journeyError || !journey?.id) {
      return res.status(404).json({ success: false, message: "Active journey not found" });
    }

    // 3. Extract last spotpin as destination (optional)
    let destination = null;
    if (Array.isArray(journey.spotpins) && journey.spotpins.length > 0) {
      destination = journey.spotpins[journey.spotpins.length - 1];
    }

    // 4. End the journey and deactivate user
    const [{ error: userUpdateError }, { error: journeyUpdateError }] = await Promise.all([
      supabase.from("users").update({ status: false }).eq("username", username),
      supabase
        .from("journey")
        .update({ status: false, destination })
        .eq("id", journey.id),
    ]);

    if (userUpdateError || journeyUpdateError) {
      console.error("❌ Update errors:", userUpdateError, journeyUpdateError);
      return res.status(500).json({ success: false, message: "Failed to end journey" });
    }

    return res.json({
      success: true,
      message: "Journey ended and destination saved",
      destination,
    });
  } catch (err) {
    console.error("❌ Server error on end-journey:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/return-profile", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ success: false, message: "Username is required." });
  }

  try {
    // 1. Fetch user data
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("username, profilepic")
      .eq("username", username)
      .single();

    if (userError || !user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // 2. Fetch user's posts
    const { data: posts, error: postsError } = await supabase
      .from("posts")
      .select("image, title, description, summery")
      .eq("username", username);

    if (postsError) {
      return res.status(500).json({ success: false, message: "Error fetching posts." });
    }

    const numberOfPosts = posts.length;

    // 3. Return all the info to the frontend
    return res.json({
      success: true,
      profile: {
        username: user.username,
        profilepic: user.profilepic,
        numberOfPosts,
        posts,
      },
    });

  } catch (err) {
    console.error("Error in /return-profile:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});


// ----------------------follow-------------------------
// -------------------- FOLLOW ---------------------------
app.post("/follow", async (req, res) => {
  const { follower, following } = req.body;

  if (!follower || !following || follower === following) {
    return res.status(400).json({ error: "Invalid request." });
  }

  try {
    // Fetch both users
    const { data: targetUser } = await supabase
      .from("users")
      .select("followers")
      .eq("username", following)
      .single();

    const { data: sourceUser } = await supabase
      .from("users")
      .select("following")
      .eq("username", follower)
      .single();

    if (!targetUser || !sourceUser) {
      return res.status(404).json({ error: "User(s) not found." });
    }

    // Update followers
    const newFollowers = [...new Set([...(targetUser.followers || []), follower])];
    await supabase
      .from("users")
      .update({
        followers: newFollowers,
        followers_count: newFollowers.length,
      })
      .eq("username", following);

    // Update following
    const newFollowing = [...new Set([...(sourceUser.following || []), following])];
    await supabase
      .from("users")
      .update({
        following: newFollowing,
        following_count: newFollowing.length,
      })
      .eq("username", follower);

    res.json({ success: true, message: `${follower} now follows ${following}` });

  } catch (err) {
    console.error("Follow error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// -------------------- UNFOLLOW ---------------------------
app.post("/unfollow", async (req, res) => {
  const { follower, following } = req.body;

  if (!follower || !following || follower === following) {
    return res.status(400).json({ error: "Invalid request." });
  }

  try {
    const { data: targetUser } = await supabase
      .from("users")
      .select("followers")
      .eq("username", following)
      .single();

    const { data: sourceUser } = await supabase
      .from("users")
      .select("following")
      .eq("username", follower)
      .single();

    if (!targetUser || !sourceUser) {
      return res.status(404).json({ error: "User(s) not found." });
    }

    // Remove from followers
    const updatedFollowers = (targetUser.followers || []).filter(u => u !== follower);
    await supabase
      .from("users")
      .update({
        followers: updatedFollowers,
        followers_count: updatedFollowers.length,
      })
      .eq("username", following);

    // Remove from following
    const updatedFollowing = (sourceUser.following || []).filter(u => u !== following);
    await supabase
      .from("users")
      .update({
        following: updatedFollowing,
        following_count: updatedFollowing.length,
      })
      .eq("username", follower);

    res.json({ success: true, message: `${follower} unfollowed ${following}` });

  } catch (err) {
    console.error("Unfollow error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// -------------------- GET FOLLOWS INFO ---------------------------
app.post("/getfollows-info", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username is required." });
  }

  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("followers, following, followers_count, following_count")
      .eq("username", username)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({
      success: true,
      username,
      followersCount: user.followers_count || 0,
      followingCount: user.following_count || 0,
      followers: user.followers || [],
      following: user.following || [],
    });

  } catch (err) {
    console.error("Get follows error:", err);
    res.status(500).json({ error: "Server error" });
  }
});



// ----------------Server-Kick-Start--------------------

app.listen(process.env.PORT, () =>
  console.log(`API ready → http://localhost:${process.env.PORT}`)
);

