import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import { js2xml } from "xml-js";
import { WebSocket, WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import twilio from "twilio";
const { VoiceResponse } = twilio.twiml;

// Constants
const SYSTEM_MESSAGE =
  "You are Santa. Kids are calling to check on the status of their Christmas presents. Reassure them all is well and to remember to be a good to their parents.";
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
const { OPENAI_API_KEY } = process.env;

console.log("Starting Santa Call Center...");
console.log("OpenAI API Key:", OPENAI_API_KEY);
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- STEP 1: Inbound call webhook ---
// Twilio will POST here when a call comes in

app.post("/incoming-call", (req, res) => {
  const signature = req.headers["x-twilio-signature"];
  const url = `https://${req.headers.host}${req.originalUrl}`;
  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!isValid) {
    console.error("Invalid Twilio request.");
    return res.status(403).send("Forbidden");
  }

  const callerNumber = req.body.From;
  const additionalDigits = req.body.Digits ? `#${req.body.Digits}` : "";
  console.log(`Incoming call from: ${callerNumber} :: ${additionalDigits}`);

  const response = new VoiceResponse();
  const connect = response.connect();
  connect.stream({
    name: "Santa Audio Stream",
    url: `wss://${req.headers.host}/media-stream`,
    track: "inbound_track",
  });
  response.say("Thanks for calling. Connecting you to Santa now.");
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

wss.on("connection", (connection) => {
  console.log("Twilio media stream connected.");

  // --- STEP 3: Connect to OpenAI Realtime API ---
  //   const openAiUrl =
  //     "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

  try {
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
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };
      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };
    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(sendSessionUpdate, 250); // Ensure connection stability, send after .25 seconds
    });
    // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
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
