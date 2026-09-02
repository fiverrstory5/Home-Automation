
const char OFFLINE_HTML[] PROGMEM = R"=====(
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HomeAuto Offline Control</title>
    <style>
        body { font-family: Arial, sans-serif; background-color: #1a1c23; color: white; margin: 0; padding: 20px; text-align: center; }
        h1 { color: #3498db; }
        .card { background: #2c3e50; padding: 20px; border-radius: 10px; margin: 10px auto; max-width: 400px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .btn { display: inline-block; width: 100%; padding: 15px; margin-top: 10px; font-size: 18px; border: none; border-radius: 5px; cursor: pointer; transition: 0.3s; font-weight: bold; }
        .btn-off { background: #7f8c8d; color: white; }
        .btn-on { background: #2ecc71; color: white; }
        .btn-emerg { background: #f39c12; color: white; margin-top: 20px; }
        .data-row { display: flex; justify-content: space-between; margin: 10px 0; font-size: 18px; border-bottom: 1px solid #34495e; padding-bottom: 5px; }
        .val { font-weight: bold; color: #f1c40f; }
        
        /* Lockdown Overlay */
        #lock-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(231, 76, 60, 0.95); z-index: 999; flex-direction: column; justify-content: center; align-items: center; }
        #lock-overlay h1 { color: white; font-size: 40px; margin-bottom: 10px; }
    </style>
</head>
<body>

    <div id="lock-overlay">
        <h1>SYSTEM LOCKED</h1>
        <p>Remote lockdown active. Controls disabled.</p>
    </div>

    <h1>Offline Dashboard</h1>
    
    <div class="card">
        <h3>Live Sensors</h3>
        <div class="data-row"><span>Battery</span> <span class="val"><span id="bat-pct">--</span>% (<span id="bat-v">--</span>V)</span></div>
        <div class="data-row"><span>Power Usage</span> <span class="val"><span id="pow">--</span> W</span></div>
        <div class="data-row"><span>Temperature</span> <span class="val"><span id="tmp">--</span> &deg;C</span></div>
        <div class="data-row"><span>Humidity</span> <span class="val"><span id="hum">--</span> %</span></div>
    </div>

    <div class="card">
        <h3>Manual Controls</h3>
        <button id="btn-fan" class="btn btn-off" onclick="toggle('fan')">Fan: OFF</button>
        <button id="btn-light1" class="btn btn-off" onclick="toggle('inLight')">Inside Light: OFF</button>
        <button id="btn-light2" class="btn btn-off" onclick="toggle('outLight')">Outside Light: OFF</button>
        
        <button class="btn btn-emerg" onclick="toggle('emerg')">FAN EMERGENCY (10 Mins)</button>
    </div>

    <script>
        function updateUI() {
            fetch("/api/status").then(r => r.json()).then(data => {
                if(data.locked) {
                    document.getElementById("lock-overlay").style.display = "flex";
                } else {
                    document.getElementById("lock-overlay").style.display = "none";
                }
                
                document.getElementById("bat-pct").innerText = data.bat_pct;
                document.getElementById("bat-v").innerText = data.bat_v.toFixed(1);
                document.getElementById("pow").innerText = Math.round(data.pow);
                document.getElementById("tmp").innerText = data.tmp.toFixed(1);
                document.getElementById("hum").innerText = Math.round(data.hum);
                
                updateBtn("btn-fan", data.fan, "Fan");
                updateBtn("btn-light1", data.inLight, "Inside Light");
                updateBtn("btn-light2", data.outLight, "Outside Light");
            }).catch(e => console.log("Fetch error"));
        }
        
        function updateBtn(id, state, name) {
            let btn = document.getElementById(id);
            if(state) {
                btn.className = "btn btn-on";
                btn.innerText = name + ": ON";
            } else {
                btn.className = "btn btn-off";
                btn.innerText = name + ": OFF";
            }
        }
        
        function toggle(device) {
            fetch("/api/toggle_" + device).then(updateUI);
        }
        
        setInterval(updateUI, 2000);
        updateUI();
    </script>
</body>
</html>
)=====";

