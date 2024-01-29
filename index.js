
import fs from 'fs';
import cors from "cors";
import process from "process";
import express from "express";

const app = express();

let configPath = "config.json";
if (process.argv.length > 2) {
  configPath = process.argv[2];
}
let config = JSON.parse(fs.readFileSync(configPath, "utf8"));
console.log(config);

let serverConnectionCount = [];
let serverConnectionQueue = [];

for (let _ of config.destinationServers) {
  serverConnectionCount.push(0);
}

app.use(express.json({limit: "500mb"})); // for parsing application/json
app.use(express.urlencoded({limit: "500mb"}));
app.use(cors());


async function executeRequest(req, res, serverIndex) {
  serverConnectionCount[serverIndex] += 1;
  try {
    console.log("executing request", config.destinationServers[serverIndex] + req.url, req.body);
    let response = await fetch(
      "http://" + config.destinationServers[serverIndex] + req.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(req.body),
      }
    );
    let blob = await response.blob();
    res.send(Buffer.from(await blob.arrayBuffer()));
  }
  catch (e) {
    console.log("error with request");
    console.log(e);
    res.end("error");
  }
  serverConnectionCount[serverIndex] -= 1;
}

function getAvailableServerIndex() {
  let minimum = config.maximumRequestsPerServer;
  let minimumIndex = -1;
  for (let i = 0; i < serverConnectionCount.length; i++) {
    if (serverConnectionCount[i] < minimum) {
      minimum = serverConnectionCount[i];
      minimumIndex = i;
    }
  }

  return minimumIndex;
}

function addToQueue(callback) {
  serverConnectionQueue.push(callback);
  processQueue();
}

async function processQueue() {
  while(serverConnectionQueue.length > 0) {
    let serverIndex = getAvailableServerIndex();
    if (serverIndex < 0) return;
    serverConnectionCount[serverIndex] += 1;
    let callback = serverConnectionQueue.shift();
    await callback(serverIndex);
    serverConnectionCount[serverIndex] -= 1;
  }
}

app.post("*", (req, res) => {
  addToQueue(async (serverIndex) => {
    await executeRequest(req, res, serverIndex);
  })
})

let port = config.port;
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
