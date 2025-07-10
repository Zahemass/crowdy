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
      .update({ scores: row.scores + 5 })
      .eq("username", username)
      .select("scores")        // get new value back

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
        return res.status(400).json({ error: "Latitude and longitude must be numbers" });
      }

      // STEP 1: Transcribe audio
      // const whisperForm = new FormData();
      // whisperForm.append("audio", audioFile.buffer, {
      //   filename: "audio.mp3",
      //   contentType: audioFile.mimetype || "audio/mpeg",
      // });

      // const whisperRes = await axios.post(
      //   "http://127.0.0.1:5002/transcribe",
      //   whisperForm,
      //   { headers: whisperForm.getHeaders() }
      // );

      // const transcription = whisperRes.data.text?.trim() || "";
      // console.log("📝 Transcription:", transcription);

      // STEP 2: Translate to multiple languages using Lara SDK
      // const translatedCaptions = {
      //   fr: await translateText(transcription, "fr-FR"),
      //   de: await translateText(transcription, "de-DE"),
      //   hi: await translateText(transcription, "hi-IN"),
      // };

      // const summary = "Quick summary: " + transcription.split(" ").slice(0, 6).join(" ") + "...";

      // STEP 3: Insert into Supabase
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
        caption: 'transcription',
        transcription: 'transcription',
        translated_captions: 'translatedCaptions',
        summary: 'summary',
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
      const postCount = await updatePostCountForUser(username, supabase);
      res.json({ username, scores: newCount, postCount });
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

    if (!spots || spots.length === 0) {
      console.error("❌ No spot found for query:", { username, latitude, longitude });
      return res.status(404).json({ error: "Spot not found" });
    }

    // Return the first matched spot
    const spot = spots[0];

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
    // First, get the current view count for that spot
    const { data: spot, error: fetchErr } = await supabase
      .from("spots")
      .select("viewcount")
      .eq("latitude", lat)
      .eq("longitude", lon)
      .single();

    if (fetchErr) throw fetchErr;

    const newViewCount = (spot.viewcount || 0) + 1;

    // Now update the view count
    const { data: updatedSpot, error: updateErr } = await supabase
      .from("spots")
      .update({ viewcount: newViewCount })
      .eq("latitude", lat)
      .eq("longitude", lon)
      .select()
      .single();

    if (updateErr) throw updateErr;

    console.log("Updated view count:", updatedSpot.viewcount);
  } catch (error) {
    console.error("ViewCount error:", error.message);
  }
}

app.get("/fullspot", async (req, res) => {
  // Using hardcoded values for testing
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
    ViewCount(latitude,longitude);
    const { data: spot, error } = await supabase
      .from("spots")
      .select("image, audio_url")
      .eq("username", username)
      .eq("latitude", latitude)
      .eq("longitude", longitude)
      .limit(1)
      .maybeSingle(); // ✅ safer than .single()

    if (error) {
      console.error("❌ Supabase error:", error.message);
      return res.status(500).json({ error: "Database error" });
    }

    if (!spot) {
      console.error("❌ No spot found for given criteria");
      return res.status(404).json({ error: "Spot not found" });
    }

    console.log("✅ Spot found:", spot.audio_url);

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

  console.log("🔎 Incoming Query Params:", { username, lat, lon, lang });

  if (!username || !lat || !lon || !lang) {
    console.warn("⚠️ Missing required query parameters");
    return res.status(400).json({
      error: "username, lat, lon, and lang query parameters are required"
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  console.log(`📌 Parsed lat/lon: ${latitude}, ${longitude}`);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    console.error("❌ Invalid lat/lon values");
    return res.status(400).json({
      error: "lat and lon must be valid numbers"
    });
  }

  // 🌐 Map language name to language code
  const langMap = {
    english: "en",
    french: "fr",
    hindi: "hi",
    german: "de"
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
        error: `Translation for language '${langCode}' not found`
      });
    }

    console.log("✅ Translation found:", translation);

    return res.status(200).json({
      username: spot.username,
      latitude: spot.latitude,
      longitude: spot.longitude,
      language: langCode,
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
      console.error("❌ No spot found for query:", { username, latitude, longitude });
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
  const userLat = Number(req.query.lat);  // ← fixed
  const userLng = Number(req.query.lng);  // ← fixed

  if (Number.isNaN(userLat) || Number.isNaN(userLng)) {
    return res.status(400).json({ error: "lat & lng query params are required numbers" });
  }

  const { data: spots, error } = await supabase
    .from("spots")
    .select("spotname, latitude, longitude, category, username"); // 👈 include username


  if (error) return res.status(500).json({ error: error.message });

  const result = spots
    .map(s => ({
      ...s,
      distance: distanceMeters(userLat, userLng, s.latitude, s.longitude)
    }))
    .filter(s => s.distance <= 3000)
    .sort((a, b) => a.distance - b.distance);
  console.log(result)
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
      .select("postcount")
      .ilike("username", cleanUsername)
      .single();

    console.log("🧩 Supabase user result:", user);
    console.log("🧩 Supabase error:", userErr);

    if (userErr || !user) {
      return res.status(404).json({ error: "User not found" });
    }

    const { data: spots, error: spotErr } = await supabase
      .from("spots")
      .select("image, spotname, viewcount, likes_count")
      .ilike("username", cleanUsername);

    if (spotErr) {
      return res.status(500).json({ error: "Error fetching spots" });
    }

    const uploaded_spots = spots.map(spot => ({
      spotimage: spot.image,
      title: spot.spotname,
      viewscount: spot.viewcount,
      likescount: spot.likes_count
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
      postcount: user.postcount || 0,
      score: badges.scores || 0,
      uploaded_spots
    });

  } catch (err) {
    console.error("❌ Profile fetch error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ----------------Server-Kick-Start--------------------

app.listen(process.env.PORT, () =>
  console.log(`API ready → http://localhost:${process.env.PORT}`)
);
