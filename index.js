import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import { js2xml } from "xml-js";
import { WebSocket, WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import twilio from "twilio";
const { VoiceResponse } = twilio.twiml;

// Constants
const DEFAULT_SYSTEM_MESSAGE =
  "You are Santa. Kids are calling to check on the status of their Christmas presents.";

const SYSTEM_MESSAGES = {
  1: DEFAULT_SYSTEM_MESSAGE,
  1086: "You are Santa. Michael has called you. He asked his parents, Yakoo and Peetray for a special beyblade. Ask him questions about what he wants and reassure him that you are working hard to make his Christmas special.",
  72580:
    "You are Santa. You have been called by Elise. Elise loves to read fantasy books, loves to travel, loves degustations / food and really enjoys time at the beach. Elise works at a charity helping people with blindness and low vision. She has worked really long hours and weekends this year to support her charity. She even has to travel over the Christmas holiday to a charity event and will miss some time at home with family, but she will be back on Christmas Eve just in time for Christmas. Ask him questions about what he wants and reassure him that you are working hard to make his Christmas special.",
  8888: "You are Santa. You have been called by Michelle. Michelle is a lovely grade school teacher and a mother who is always looking after her family. Michelle loves the holiday season and always makes this time of year special for her family. Ask her questions about what he wants and reassure him that you are working hard to make his Christmas special.",
  9999: "You are Santa. You have been called by John. John is cheeky but always looks after his family. This year he worked extra hard to get a pool built for his family. His parents are Bridge and PJ. Ask him questions about what he wants and reassure him that you are working hard to make his Christmas special.",
};

const SYSTEM_MESSAGE_APPEND = " Remember to be a good to their parents.";

let SYSTEM_MESSAGE = DEFAULT_SYSTEM_MESSAGE;

const VOICE = "ash";
// List of Event Types to log to the console. See OpenAI Realtime API Documentation. (session.updated is handled separately.)
const LOG_EVENT_TYPES = [
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];

// Load environment variables
const { OPENAI_API_KEY, TWILIO_AUTH_TOKEN } = process.env;

console.log("Starting Santa Call Center...");
console.log("OpenAI API Key:", OPENAI_API_KEY);
console.log("Twilio Auth Token:", TWILIO_AUTH_TOKEN);
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- STEP 1: Inbound call webhook ---
// Twilio will POST here when a call comes in

app.post("/incoming-call", (req, res) => {
  const signature = req.headers["x-twilio-signature"];
  const url = `https://${req.headers.host}${req.originalUrl}`;
  const isValid = twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!isValid) {
    console.error("Invalid Twilio request.");
    return res.status(403).send("Forbidden");
  }

  //   const callerNumber = req.body.From;
  //   const additionalDigits = req.body.Digits ? `#${req.body.Digits}` : "";
  //   console.log(`Incoming call from: ${callerNumber} :: ${additionalDigits}`);

  const response = new VoiceResponse();
  // Gather digits
  const gather = response.gather({
    input: "dtmf", // Collect DTMF tones
    action: "/process-gather", // URL to handle the gathered input
    method: "POST",
    timeout: 5, // Wait time for input
    numDigits: 5, // Maximum number of digits to gather
  });
  gather.play(
    "https://firebasestorage.googleapis.com/v0/b/tdu-taupo-classic.firebasestorage.app/o/north_pole_greeting.mp3?alt=media&token=54e08421-dcfc-464c-a6ac-69d376f1273d"
  );
  //   gather.say("Please enter the additional numbers followed by the pound sign.");

  // If no input is received, fall back to a default action
  response.play(
    "https://firebasestorage.googleapis.com/v0/b/tdu-taupo-classic.firebasestorage.app/o/ElevenLabs_2024-12-22T04_04_08_Father%20Christmas%20-%20magical%20storyteller%2C%20older%20British%20English%20male_pvc_s50_sb75_t2.mp3?alt=media&token=5f941861-6b6b-49d1-8c38-500da6d86f24"
  );

  // Respond with the initial TwiML
  console.log(response.toString());
  res.type("text/xml");
  res.send(response.toString());
  console.log(response.toString());
});

app.post("/process-gather", (req, res) => {
  const digits = req.body.Digits;
  console.log(`Digits received: ${digits}`);

  const response = new VoiceResponse();

  if (digits) {
    // Log the digits and proceed with the connection
    console.log(`Connecting with additional input: ${digits}`);
    response.play(
      "https://firebasestorage.googleapis.com/v0/b/tdu-taupo-classic.firebasestorage.app/o/ElevenLabs_2024-12-22T04_05_58_Father%20Christmas%20-%20magical%20storyteller%2C%20older%20British%20English%20male_pvc_s71_sb75_t2.mp3?alt=media&token=f1ffc462-9cb6-4f58-a381-992abee01519"
    );
    if (SYSTEM_MESSAGES[digits]) {
      SYSTEM_MESSAGE = SYSTEM_MESSAGES[digits];
      console.log("System message updated:", SYSTEM_MESSAGE);
    }
  } else {
    // Handle missing input
    response.play(
      "https://firebasestorage.googleapis.com/v0/b/tdu-taupo-classic.firebasestorage.app/o/ElevenLabs_2024-12-22T04_04_08_Father%20Christmas%20-%20magical%20storyteller%2C%20older%20British%20English%20male_pvc_s50_sb75_t2.mp3?alt=media&token=5f941861-6b6b-49d1-8c38-500da6d86f24"
    );
  }
  const connect = response.connect();
  connect.stream({
    name: "Santa Audio Stream",
    url: `wss://${req.headers.host}/media-stream`,
    track: "inbound_track",
  });
  console.log("Received incoming call from Twilio. \n", response.toString());
  res.type("text/xml");
  res.send(response.toString());
});

// --- STEP 2: Media Stream Endpoint ---
// Twilio will connect via WebSocket and send binary or JSON frames with audio data.
// For this example, we'll create a WebSocket server endpoint in the same app.
// Note: Typically you'd have a separate route or server for this.

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Create a WebSocket server for Twilio media streams
const wss = new WebSocketServer({ server, path: "/media-stream" });

// Unique session identifier
let sessionId = uuidv4();

const INITIAL_ULAW_AUDIO_URL =
  "https://firebasestorage.googleapis.com/v0/b/tdu-taupo-classic.firebasestorage.app/o/hello_santa.ulaw?alt=media&token=5054c8a6-8b95-4742-a2ba-696f721139d6";

// 2) Utility to fetch the G.711 file, convert to base64
async function fetchUlawBase64(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch G.711 file: ${res.status}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuf);
  // Convert raw G.711 data to base64
  return audioBuffer.toString("base64");
}

wss.on("connection", (connection) => {
  console.log("Twilio media stream connected.");

  try {
    // (1) Read your G.711 µ-law file from disk and base64-encode it
    // In this example, "hello.ul" is a raw 8 kHz G.711 µ-law file
    let initialAudioBase64 = null;
    try {
      const audioFileBuffer = fs.readFileSync("./bin/hello_santa.ulaw"); // or an absolute path
      initialAudioBase64 = audioFileBuffer.toString("base64");
      console.log("Successfully loaded and encoded hello_santa.ulaw");
    } catch (err) {
      console.error("Failed to read hello.ul:", err);
    }

    console.log("Client connected");
    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    let streamSid = null;

    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE + SYSTEM_MESSAGE_APPEND,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };
      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));

      // (2) Send initial audio buffer if we have it
      // Replace the "Hello Santa" string with your actual G.711 data
      if (initialAudioBase64) {
        const initialAudioBuffer = {
          type: "input_audio_buffer.append",
          audio: initialAudioBase64,
        };
        console.log("Sending initial audio buffer:", initialAudioBuffer);
        openAiWs.send(JSON.stringify(initialAudioBuffer));
      } else {
        console.log("No initial audio file was loaded.");
      }
    };

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(sendSessionUpdate, 250); // Ensure connection stability
    });

    // Handle incoming messages from OpenAI
    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);
        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }
        if (response.type === "session.updated") {
          console.log("Session updated successfully:", response);
        }
        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: {
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          connection.send(JSON.stringify(audioDelta));
        }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error,
          "Raw message:",
          data
        );
      }
    });

    // Handle incoming messages from Twilio
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case "media":
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case "start":
            streamSid = data.start.streamSid;
            console.log("Incoming stream has started", streamSid);
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message);
      }
    });

    // Handle connection close
    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Client disconnected.");
    });

    // Handle WebSocket close and errors
    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });
    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });
  } catch (error) {
    console.error("Error initializing OpenAI WebSocket:", error);
  }
});

// --- STEP 4: Endpoint to serve the generated audio TwiML ---

app.post("/play-generated-audio", (req, res) => {
  const response = {
    Response: {
      Play: {
        _text: `https://${req.headers.host}/generated_audio_${sessionId}.wav`,
      },
    },
  };
  const twiml = js2xml(response, { compact: true });
  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

// --- STEP 5: Serve the generated audio file ---
app.get(`/generated_audio_${sessionId}.wav`, (req, res) => {
  const file = `./generated_audio_${sessionId}.wav`;
  if (fs.existsSync(file)) {
    res.set("Content-Type", "audio/wav");
    fs.createReadStream(file).pipe(res);
  } else {
    res.status(404).send("Not found");
  }
});
