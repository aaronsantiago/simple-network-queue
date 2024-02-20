
import fs from 'fs';
import cors from "cors";
import process from "process";
import express from "express";

let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

let parseDbData = [];

if (config.useParseDb) {
  setInterval(async () => {
    const url = config.parseDbUrl;
    const headers = {
      Accept: "application/json",
      "X-Parse-Application-Id": config.parseDbAppId,
      "X-Parse-REST-API-Key": config.parseDbRestApiKey,
      "Content-Type": " application/json",
    };
    // let queryParams = "?where=" + JSON.stringify({tulpa_id: tulpaId});
    let queryParams = "";

    try {
      let response = await fetch(url + queryParams, {
        method: "GET", // or 'PUT'
        headers: headers,
      });
      let data = await response.json();
      parseDbData = data.results;
      // console.log(data);
    } catch (error) {
      if (error.name === "AbortError") {
        console.log("Fetch aborted");
        return;
      }
      console.error("Error:", error);
    }
  }, 1000);
}


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

let waitingForDebounce = false;
function addToQueue(callback) {
  serverConnectionQueue.push(callback);
  if (!waitingForDebounce) {
    waitingForDebounce = true;
    (async () => {
      await sleep(config.requestDebounceTime);
      waitingForDebounce = false;
      processQueue();
    })();
  }
}

async function processQueue() {
  while(serverConnectionQueue.length > 0) {
    let serverIndex = getAvailableServerIndex();
    if (serverIndex < 0) return;
    serverConnectionCount[serverIndex] += 1;
    let connectionIndex = 0;
    if (config.usePriorityField) {
      let priority = Infinity;
      for (let i = 0; i < serverConnectionQueue.length; i++) {
        let connectionPriority = serverConnectionQueue[i].priority;
        if (config.useParseDb) {
          let dbValue = parseDbData.find((x) => x[config.parseDbDbField] == serverConnectionQueue[i].dbField);
          dbValue = dbValue[config.parseDbValueField];
          connectionPriority -= dbValue;
          console.log("calculating priority", connectionPriority, serverConnectionQueue[i].dbField, serverConnectionQueue[i].priority, dbValue)
        }
        if (connectionPriority < priority) {
          connectionIndex = i;
          priority = serverConnectionQueue[i].priority;
        }
      }
    }
    let callback = serverConnectionQueue.splice(connectionIndex, 1)[0].callback;
    await callback(serverIndex);
    serverConnectionCount[serverIndex] -= 1;
  }
}

app.post("*", (req, res) => {
  let serverConnection = {callback: async (serverIndex) => {
    await executeRequest(req, res, serverIndex);
  }};
  if (config.usePriorityField) {
    serverConnection.priority = req.body[config.priorityField];
  }
  if (config.useParseDb) {
    serverConnection.dbField = req.body[config.parseDbRequestField];
  }
  console.log("adding to queue:", serverConnection);
  addToQueue(serverConnection)
})

let port = config.port;
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
