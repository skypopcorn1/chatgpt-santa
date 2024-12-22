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
  1086: "You are Santa. Michael has called you. He asked his parents, Yakoo and Peetray for a special beyblade. Ask him questions about what he wants and reassure him that you are working hard to make his Christmas special.",
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
  gather.say("Please enter the additional numbers followed by the pound sign.");

  // If no input is received, fall back to a default action
  response.say("We did not receive your input. Connecting you to Santa now.");

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
    response.say("Connecting you to Santa now");
    if (SYSTEM_MESSAGES[digits]) {
      SYSTEM_MESSAGE = SYSTEM_MESSAGES[digits];
      console.log("System message updated:", SYSTEM_MESSAGE);
    }
  } else {
    // Handle missing input
    response.say("No input received. Connecting you to Santa now.");
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

wss.on("connection", (connection) => {
  console.log("Twilio media stream connected.");

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

    const createConversation = () => {
      const conversationCreateEvent = {
        type: "conversation.create",
        conversation: {
          messages: [
            {
              role: "system",
              content: SYSTEM_MESSAGE + SYSTEM_MESSAGE_APPEND, // Define the system instructions here
            },
          ],
          modalities: ["text", "audio"],
        },
      };
      console.log(
        "Sending conversation.create event:",
        JSON.stringify(conversationCreateEvent)
      );
      openAiWs.send(JSON.stringify(conversationCreateEvent));
    };

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(createConversation, 250); // Trigger conversation creation
    });

    // Handle incoming messages from OpenAI
    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);
        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }
        if (response.type === "conversation.response" && response.response) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: {
              payload: Buffer.from(response.response.audio, "base64").toString(
                "base64"
              ),
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
