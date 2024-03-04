
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

async function executeRequest(req, res, serverIndex, method) {
  serverConnectionCount[serverIndex] += 1;

  try {
    console.log("executing request", config.destinationServers[serverIndex] + req.url);
    let modifiedHeaders = {...req.headers};
    
    delete modifiedHeaders["content-length"];

    let response = await fetch(
      "http" + (config.useHttps ? "s" : "") +  "://" + config.destinationServers[serverIndex] + req.url,
      {
        method: method,
        headers: modifiedHeaders,
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
  let minimumIndices = [];
  for (let i = 0; i < serverConnectionCount.length; i++) {
    if (config.randomizeDestinationServer) {
      if (serverConnectionCount[i] < minimum) {
        minimum = serverConnectionCount[i];
        minimumIndices = [];
      }
      if (serverConnectionCount[i] == minimum) {
        minimumIndices.push(i);
      }
    }
    else {
      if (serverConnectionCount[i] < minimum) {
        minimum = serverConnectionCount[i];
        minimumIndex = i;
      }
    }
  }

  if (config.randomizeDestinationServer && minimumIndices.length > 0) {
    minimumIndex = minimumIndices[Math.floor(Math.random() * minimumIndices.length)];
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
          priority = connectionPriority;
        }
      }
    }
    let callback = serverConnectionQueue.splice(connectionIndex, 1)[0].callback;
    await callback(serverIndex);
    serverConnectionCount[serverIndex] -= 1;
  }
}

let bundledRequests = {};

app.post("*", (req, res) => {
  handleRequest(req, res, "POST");
});

app.get("*", (req, res) => {
  handleRequest(req, res, "GET");
});

app.put("*", (req, res) => {
  handleRequest(req, res, "PUT");
});

app.options("*", (req, res) => {
  handleRequest(req, res, "OPTIONS");
});

function handleRequest(req, res, method) {
  let serverConnection = {callback: async (serverIndex) => {
    await executeRequest(req, res, serverIndex, method);
  }};
  if (config.usePriorityField) {
    serverConnection.priority = req.body[config.priorityField];
  }
  if (config.useParseDb) {
    serverConnection.dbField = req.body[config.parseDbRequestField];
  }
  if (req.body["snqBundleId"]) {
    let bid = req.body["snqBundleId"];
    if (!bundledRequests[bid]) {
      bundledRequests[bid] = [];
    }
    serverConnection.bundleOrder = req.body["snqBundleOrder"];
    if (serverConnection.bundleOrder != null) {
      let insertionFound = false;
      for (let i = 0; i < bundledRequests[bid].length; i++) {
        console.log("checking bundle order", bundledRequests[bid][i].bundleOrder, serverConnection.bundleOrder);
        if (bundledRequests[bid][i].bundleOrder > serverConnection.bundleOrder) {
          bundledRequests[bid].splice(i, 0, serverConnection);
          insertionFound = true;
          break;
        }
      }
      if (!insertionFound) {
        bundledRequests[bid].push(serverConnection);
      }
    }
    else {
      bundledRequests[bid].push(serverConnection);
    }
    console.log("adding to bundle", req.body["snqBundleId"], bundledRequests[req.body["snqBundleId"]].length);
    if (bundledRequests[bid].length == req.body["snqBundleSize"]) {
      console.log("adding bundle to queue", req.body["snqBundleId"]);
      addToQueue({
        callback: async (serverIndex) => {
          for (let i = 0; i < bundledRequests[bid].length; i++) {
            await bundledRequests[bid][i].callback(serverIndex);
          }
          delete bundledRequests[bid];
        },
        priority: serverConnection.priority,
        dbField: serverConnection.dbField
      });
    }
  }
  else {
    console.log("adding to queue:", serverConnection);
    addToQueue(serverConnection)
  }
};

let port = config.port;
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
