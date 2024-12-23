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
  "You are Santa. You have deep voice with British Accent. Kids are calling to check on the status of their Christmas presents.";

const SYSTEM_MESSAGES = {
  1: DEFAULT_SYSTEM_MESSAGE,
  1086: "You are Santa. You have deep voice with British Accent. Michael has called you. He asked his parents, Yakoo and Peetray for a special beyblade. Ask him questions about what he wants and reassure him that you are working hard to make his Christmas special.",
  619: "You are Santa. You have deep voice with British Accent. You have been called by Tammy a recent retiree. Tammy has 3 grandchildren, Miles, Jane and Edith. She also recently got a new puppy named Milo. Tammy loves to travel and work in her garden. Ask her questions about what she wants for Christmas.",
  72580:
    "You are Santa Claus. You have deep voice with British Accent.  You have been called by Elise. Elise loves to read fantasy books, loves to travel, loves degustations / food and really enjoys time at the beach. Elise works at a charity helping people with blindness and low vision. She has worked really long hours and weekends this year to support her charity. She even has to travel over the Christmas holiday to a charity event and will miss some time at home with family, but she will be back on Christmas Eve just in time for Christmas. Ask him questions about what he wants and reassure him that you are working hard to make his Christmas special.",
  8181: "You are Santa with an Irish accent. Never say 'top of the morning'. You have been called by Anna. Anna is a young girl with typical interests. Anna's parents are John and Michelle. Ask her questions about what she wants and reassure her that you are working hard to make her Christmas special. Keep the conversation kid friendly.",
  8888: "You are Santa with an Irish accent. Never say 'top of the morning'. You have been called by Michelle. Michelle is a lovely grade school teacher and a mother who is always looking after her family. Michelle loves the holiday season and always makes this time of year special for her family. Ask her questions about what he wants and reassure him that you are working hard to make his Christmas special.",
  9191: "You are Santa with an Irish accent. Never say 'top of the morning'. You have been called by Noah. Noah is a young boy. Noah plays a lot of sports including Rugby and Swimming. He also likes Soccer and follows the premier league. Ask him questions about what he wants and reassure him that you are working hard to make his Christmas special. Keep the conversation kid friendly.",
  9999: "You are Santa with an Irish accent. Never say 'top of the morning'. You have been called by John. John is cheeky but always looks after his family. This year he worked extra hard to get a pool built for his family. His parents are Bridge and PJ. Ask him questions about what he wants and reassure him that you are working hard to make his Christmas special.",
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
    actionOnEmptyResult: true, // Ensures the call will continue even if no input is received
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
    console.log(
      "/process-gather: No additional input received. Connecting without additional input."
    );
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

// Keep track of sessions: { [streamSid]: { openAiWs, ... } }
const sessions = {};

// Load your G.711 µ-law file once at startup, if desired
function getInitialAudio() {
  try {
    const audioFileBuffer = fs.readFileSync("./bin/hello_santa.ulaw");
    return audioFileBuffer.toString("base64");
  } catch (err) {
    console.error("Failed to read hello_santa.ulaw:", err);
    return null;
  }
}
const initialAudioBase64 = getInitialAudio();

wss.on("connection", (connection) => {
  console.log("Twilio media stream connected. Client connected.");

  // Listen for Twilio messages
  connection.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.event) {
        case "start": {
          // A new call is starting
          const streamSid = data.start.streamSid;
          console.log("Incoming stream has started", streamSid);

          // 1) Create a new OpenAI Realtime WS for this call
          const openAiWs = new WebSocket(
            "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
            {
              headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
              },
            }
          );

          // 2) Store it in sessions
          sessions[streamSid] = { openAiWs };

          // 3) When OpenAI WS opens, send session.update and initial audio
          openAiWs.on("open", () => {
            console.log(`Connected to OpenAI Realtime for ${streamSid}`);

            // Prepare session update
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
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Send initial audio if loaded

            if (initialAudioBase64) {
              const initialAudioEvent = {
                type: "input_audio_buffer.append",
                audio: initialAudioBase64,
              };
              console.log("Sending initial audio buffer for", streamSid);
              openAiWs.send(JSON.stringify(initialAudioEvent));
            } else {
              console.log("No initial audio file was loaded.");
            }
          });

          // 4) Handle messages from OpenAI
          openAiWs.on("message", (openAiMsg) => {
            try {
              const response = JSON.parse(openAiMsg);

              // Log certain events
              if (LOG_EVENT_TYPES.includes(response.type)) {
                console.log(`Received event: ${response.type}`, response);
              }

              if (response.type === "session.updated") {
                console.log("Session updated successfully:", response);
              }

              if (response.type === "response.audio.delta" && response.delta) {
                // This is TTS audio from OpenAI in base64
                // We send it back to Twilio
                const audioDelta = {
                  event: "media",
                  streamSid: streamSid,
                  media: {
                    payload: Buffer.from(response.delta, "base64").toString(
                      "base64"
                    ),
                  },
                };
                connection.send(JSON.stringify(audioDelta));
              }
            } catch (err) {
              console.error(
                "Error processing OpenAI message:",
                err,
                "Raw message:",
                openAiMsg
              );
            }
          });

          // 5) Handle close/error on the OpenAI WS
          openAiWs.on("close", () => {
            console.log(`OpenAI WS closed for ${streamSid}`);
          });
          openAiWs.on("error", (err) => {
            console.error(`OpenAI WS error for ${streamSid}:`, err);
          });

          break; // end 'start' case
        }

        case "media": {
          // This is raw audio from Twilio in base64 G.711
          const streamSid = data.streamSid;
          // Retrieve the session
          const session = sessions[streamSid];
          if (session && session.openAiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            };
            session.openAiWs.send(JSON.stringify(audioAppend));
          }
          break;
        }

        case "stop":
          // The call/stream ended
          // Cleanup if needed
          // Possibly close the openAiWs
          // e.g.:
          const streamToStop = data.streamSid;
          console.log("Stopping call for", streamToStop);
          if (sessions[streamToStop]) {
            if (sessions[streamToStop].openAiWs.readyState === WebSocket.OPEN) {
              sessions[streamToStop].openAiWs.close();
            }
            delete sessions[streamToStop];
          }
          break;

        default:
          console.log("Received non-media event:", data.event);
          break;
      }
    } catch (error) {
      console.error("Error parsing message:", error, "Message:", message);
    }
  });

  // Handle the WebSocket server connection close
  connection.on("close", () => {
    console.log("Twilio connection closed by the client.");
    // If you want to further clean up sessions here, you could do so.
    // However, typically Twilio will send a "stop" event for each streamSid.
  });
});
