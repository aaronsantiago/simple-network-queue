
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

for (let _ of config.destinationServers) {
  serverConnectionCount.push(0);
}

app.use(express.json({limit: "500mb"})); // for parsing application/json
app.use(express.urlencoded({limit: "500mb"}));
app.use(cors());

app.post("*", async (req, res) => {
  let response = await fetch(
    "http://" + config.destinationServers[0] + req.url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    }
  );
  let blob = await response.blob();
  res.send(Buffer.from(await blob.arrayBuffer()))
})

let port = 1234;
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
