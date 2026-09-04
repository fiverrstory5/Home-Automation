
// =========================================
// FIREBASE INITIALIZATION
// =========================================
const firebaseConfig = {
    apiKey: "AIzaSyAnp0VTMBMME0WtJGHnuVLquIPeMjEfOcE",
    databaseURL: "https://myhomeauto-9122d-default-rtdb.firebaseio.com/"
};
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const database = firebase.database();
let isSystemLocked = false;
let outsideLightMode = "auto";
let outsideLightForceEnd = 0;
let fanEmergencyEnd = 0;

// Listen to Global State from Firebase
database.ref("/").on("value", (snapshot) => {
    const data = snapshot.val();
    if (!data) return;

    let isOffline = true;
    if (data.Sensor_Data && data.Sensor_Data.Last_Heartbeat) {
        updateHeartbeat(data.Sensor_Data.Last_Heartbeat);
        const currentEpoch = Math.floor(Date.now() / 1000);
        isOffline = (currentEpoch - data.Sensor_Data.Last_Heartbeat) > 60;
    }

    // SYSTEM SETTINGS
    if (data.Settings) {
        if (data.Settings.voltageOffset !== undefined) latestSettings.voltageOffset = data.Settings.voltageOffset;
        if (data.Settings.powerMultiplier !== undefined) latestSettings.powerMultiplier = data.Settings.powerMultiplier;
        if (data.Settings.pirDurationMins !== undefined) latestSettings.pirDurationMins = data.Settings.pirDurationMins;
        if (data.Settings.batteryHealth !== undefined) latestSettings.batteryHealth = data.Settings.batteryHealth;
    }

    // SENSOR DATA - Only paint if online!
    if (data.Sensor_Data && !isOffline) {

        if (data.Sensor_Data.Battery_V !== undefined) {
            document.getElementById("battery-voltage").innerText = data.Sensor_Data.Battery_V.toFixed(1) + "V";
        }
        if (data.Sensor_Data.Battery_Pct !== undefined) {
            updateBattery(data.Sensor_Data.Battery_Pct, data.Sensor_Data.Battery_V);
        }
        if (data.Sensor_Data.TimeLeft_Mins !== undefined) {
            if (data.Sensor_Data.TimeLeft_Mins === -1) {
                document.getElementById("battery-time").innerText = "Grid ON / Stable";
            } else {
                const hrs = Math.floor(data.Sensor_Data.TimeLeft_Mins / 60);
                const mins = data.Sensor_Data.TimeLeft_Mins % 60;
                document.getElementById("battery-time").innerText = `${hrs}h ${mins}m left`;
            }
        }
        if (data.Sensor_Data.Power_W !== undefined) {
            document.getElementById("current-power").innerHTML = Math.round(data.Sensor_Data.Power_W) + `<span class="unit">W</span>`;
        }
        if (data.Sensor_Data.Energy_Today_Wh !== undefined && !isViewingHistory) {
            document.getElementById("energy-total").innerHTML = (data.Sensor_Data.Energy_Today_Wh / 1000).toFixed(2) + `<span class="unit">kWh</span>`;
        }
        if (data.Sensor_Data.Temperature !== undefined) {
            const tempEl = document.getElementById("temp-value");
            if (tempEl) tempEl.innerHTML = data.Sensor_Data.Temperature.toFixed(1) + `&deg;C`;
            updateTemperature(data.Sensor_Data.Temperature);
        }
        if (data.Sensor_Data.Humidity !== undefined) {
            const humEl = document.getElementById("hum-value");
            if (humEl) humEl.innerText = data.Sensor_Data.Humidity.toFixed(0) + `%`;
        }
        if (data.Sensor_Data.Last_Heartbeat !== undefined) {
            updateHeartbeat(data.Sensor_Data.Last_Heartbeat);
        }
    }
    
    
    
    // SYSTEM LOCKDOWN
    if (data.device && data.device.state && data.device.state.System_Lock !== undefined) {
        isSystemLocked = data.device.state.System_Lock;
        const overlay = document.getElementById("lockdown-overlay");
        if (overlay) {
            overlay.style.display = isSystemLocked ? "flex" : "none";
        }
        const grid = document.querySelector(".device-grid");
        if (grid) {
            if (isSystemLocked) {
                grid.classList.add("locked-system");
            } else {
                grid.classList.remove("locked-system");
            }
        }
    }

    // DEVICE STATE - Force OFF if offline
    if (data.device && data.device.state) {
        if (isOffline) {
            updateDeviceCard("fan", false);
            updateDeviceCard("light1", false);
            updateDeviceCard("light2", false);
        } else {
            updateDeviceCard("fan", data.device.state.fanState);
            updateDeviceCard("light1", data.device.state.insideLightState);
            updateDeviceCard("light2", data.device.state.outsideLightState);
            
            if (data.device.state.outsideLightMode !== undefined) {
                outsideLightMode = data.device.state.outsideLightMode;
                const modeBadge = document.getElementById("light2-mode");
                if (modeBadge) {
                    if (outsideLightMode === "force") {
                        modeBadge.innerText = "Force";
                        modeBadge.className = "mode-badge force-mode";
                    } else {
                        if (data.device.state.outsideLightState === true) {
                            modeBadge.innerText = "Motion Detected";
                            modeBadge.className = "mode-badge auto-mode";
                            modeBadge.style.backgroundColor = "#ff9800"; // Orange alert color
                        } else {
                            modeBadge.innerText = "Auto";
                            modeBadge.className = "mode-badge auto-mode";
                            modeBadge.style.backgroundColor = ""; // Reset
                        }
                    }
                }
            }
            if (data.device.state.outsideLightForceEnd !== undefined) {
                outsideLightForceEnd = data.device.state.outsideLightForceEnd;
            }
            if (data.device.state.fanEmergencyEnd !== undefined) {
                fanEmergencyEnd = data.device.state.fanEmergencyEnd;
            }
        }
    }

    // HARDWARE CONFIRMATION (from ESP32)
    if (data.device && data.device.confirmed) {
        const conf = data.device.confirmed;
        const dev = conf.device;
        
        if (dev && pendingActions[dev]) {
            // ESP32 responded! Clear timeout and loading
            clearTimeout(pendingActions[dev]);
            delete pendingActions[dev];
            
            const card = document.getElementById(dev + "-card");
            if (card) card.classList.remove("loading");
            
            if (conf.success) {
                // Hardware confirmed - update UI to actual state
                updateDeviceCard(dev, conf.state);
            } else {
                // Hardware rejected - show error reason and revert UI
                showToast("⚠ " + (conf.reason || "Command rejected"));
                updateDeviceCard(dev, conf.state); // Show actual hardware state
            }
            
            // Clean up confirmation from Firebase
            database.ref("/device/confirmed").remove().catch(() => {});
        }
    }

});

// Variables for fan inertia animation
let fanSpeed = 0;
const MAX_SPEED = 12.0; // Max speed for video playback
let fanInterval;



// =========================================
// PENDING HARDWARE ACTIONS (Feedback Loop)
// =========================================
let pendingActions = {};

function toggleDevice(device) {
    const card = document.getElementById(device + "-card");
    if (card.classList.contains("loading")) return;

    if (isSystemLocked) {
        showToast("Error: System is Locked!");
        return;
    }

    const isOffline = (Math.floor(Date.now() / 1000) - lastHeartbeat) > 60;
    if (isOffline) {
        showToast("Error: System is Offline!");
        return;
    }
 // Prevent spamming
    
    const currentState = card.classList.contains("active");
    const expectedState = !currentState;
    
    let basePath = "/device/command";
    let updateObj = {};
    if (device === "fan") updateObj["fanState"] = expectedState;
    else if (device === "light1") updateObj["insideLightState"] = expectedState;
    else if (device === "light2") updateObj["outsideLightState"] = expectedState;
    
    if (Object.keys(updateObj).length > 0) {
        card.classList.add("loading");
        
        // Store timeout in pendingActions so updateDeviceCard can clear it
        pendingActions[device] = setTimeout(() => {
            delete pendingActions[device];
            card.classList.remove("loading");
            showToast("Error: Cloud did not respond.");
            updateDeviceCard(device, currentState); // Revert UI
            // Also revert Firebase state to prevent stale value from showing ON later
            let revertObj = {};
            if (device === "fan") revertObj["fanState"] = currentState;
            else if (device === "light1") revertObj["insideLightState"] = currentState;
            else if (device === "light2") revertObj["outsideLightState"] = currentState;
            database.ref(basePath).update(revertObj).catch(() => {});
        }, 15000);
        
        database.ref(basePath).update(updateObj)
            .catch((error) => {
                if (pendingActions[device]) {
                    clearTimeout(pendingActions[device]);
                    delete pendingActions[device];
                }
                card.classList.remove("loading");
                showToast("Error: " + error.message);
                updateDeviceCard(device, currentState);
            });
    }
}


// Update device UI state. If a pendingAction exists, skip (wait for hardware confirmation)
function updateDeviceCard(device, state) {
    const card = document.getElementById(device + "-card");
    if (!card) return;
    
    // If we're waiting for hardware confirmation, DON'T update UI from Firebase echo
    if (pendingActions[device]) {
        return; // Wait for /device/confirmed or timeout
    }
    
    if (state) {
        if (!card.classList.contains("active")) {
            card.classList.add("active");
            if (device === "fan") startFan();
        }
    } else {
        if (card.classList.contains("active")) {
            card.classList.remove("active");
            if (device === "fan") stopFan();
        }
    }
}

function startFan() {
    const video = document.getElementById('fan-video');
    if (!video) return;
    
    clearInterval(fanInterval);
    
    // Ensure video is playing
    video.play().catch(e => console.log('Autoplay prevented:', e));
    
    // Gradually increase speed
    fanInterval = setInterval(() => {
        fanSpeed += 0.1;
        if (fanSpeed >= MAX_SPEED) {
            fanSpeed = MAX_SPEED;
            clearInterval(fanInterval);
        }
        video.playbackRate = Math.max(0.1, fanSpeed);
    }, 50);
}

function stopFan() {
    const video = document.getElementById('fan-video');
    if (!video) return;
    
    clearInterval(fanInterval);
    
    // Gradually decrease speed
    fanInterval = setInterval(() => {
        fanSpeed -= 0.05; 
        if (fanSpeed <= 0.1) {
            fanSpeed = 0;
            video.pause();
            clearInterval(fanInterval);
        } else {
            video.playbackRate = fanSpeed;
        }
    }, 50);
}

window.onload = () => {
    const video = document.getElementById('fan-video');
    if (video) {
        video.pause();
        video.playbackRate = 0.1; 
    }
    
    // Client-side countdown timer for Fan Emergency and Light2 Force Mode
    setInterval(() => {
        const currentEpoch = Math.floor(Date.now() / 1000);
        
        // Fan Timer
        const fanTimerEl = document.getElementById("fan-timer");
        if (fanTimerEl) {
            if (fanEmergencyEnd > currentEpoch) {
                const diff = fanEmergencyEnd - currentEpoch;
                const m = Math.floor(diff / 60);
                const s = diff % 60;
                fanTimerEl.innerText = `${m}m ${s}s`;
                fanTimerEl.style.display = "block";
            } else {
                fanTimerEl.style.display = "none";
            }
        }
        
        // Light2 Timer
        const light2TimerEl = document.getElementById("light2-timer");
        if (light2TimerEl) {
            if (outsideLightMode === "force" && outsideLightForceEnd > currentEpoch) {
                const diff = outsideLightForceEnd - currentEpoch;
                const m = Math.floor(diff / 60);
                const s = diff % 60;
                light2TimerEl.innerText = `${m}m ${s}s`;
                light2TimerEl.style.display = "block";
            } else {
                light2TimerEl.style.display = "none";
            }
        }
    }, 1000);
};

// Battery Simulation / Control
function updateBattery(percentage, voltage) {
    const fill = document.getElementById('battery-fill');
    const pctText = document.getElementById('battery-text');
    const vText = document.getElementById('battery-voltage');
    
    if (fill && pctText) {
        pctText.innerText = percentage + '%';
        // Max width of fill is 90
        const newWidth = percentage; // Max width is 100
        fill.setAttribute('width', newWidth);
        
        // Dynamic color
        if (percentage <= 20) {
            fill.setAttribute('fill', '#e74c3c'); // Red
        } else if (percentage <= 50) {
            fill.setAttribute('fill', '#f1c40f'); // Yellow
        } else {
            fill.setAttribute('fill', '#2ecc71'); // Green
        }
    }
    if (vText && voltage !== undefined) {
        vText.innerText = Number(voltage).toFixed(2) + 'V';
    }
}
// You can test it in console: updateBattery(45, "11.8");



// Temperature Simulation / Control
function updateTemperature(temp) {
    const fill = document.getElementById('temp-fill');
    const text = document.getElementById('temp-value');
    
    if (fill && text) {
        // Create the HTML for the text + unit
        text.innerHTML = Number(temp).toFixed(1) + '<span class="temp-unit">&deg;C</span>';
        
        // Calculate height based on a max temp of 50&deg;C
        // Max height of the SVG clip box is 75 (y goes from 15 to 90)
        let percent = temp / 50;
        if (percent > 1) percent = 1;
        if (percent < 0) percent = 0.05; // Keep a little bit at the bottom
        
        const fillHeight = percent * 75;
        const fillY = 90 - fillHeight;
        
        fill.setAttribute('height', fillHeight);
        fill.setAttribute('y', fillY);
        
        // Dynamic color
        if (temp >= 35) {
            fill.setAttribute('fill', '#e74c3c'); // Red (Hot)
        } else if (temp >= 20) {
            fill.setAttribute('fill', '#f39c12'); // Orange (Warm)
        } else {
            fill.setAttribute('fill', '#3498db'); // Blue (Cool)
        }
    }
}
// You can test it in console: updateTemperature(30);



// Power / Energy Logic
window.addEventListener('DOMContentLoaded', () => {
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');
    const energyLabel = document.getElementById('energy-label');
    const energyTotal = document.getElementById('energy-total');
    
    // Set default dates to today
    const today = new Date().toISOString().split('T')[0];
    if(startDateInput && endDateInput) {
        startDateInput.value = today;
        endDateInput.value = today;
        
        function handleDateChange() {
            const start = startDateInput.value;
            const end = endDateInput.value;
            
            if (start && end) {
                if (start === today && end === today) {
                    energyLabel.innerText = "Today";
                    isViewingHistory = false;
                    // Today's energy is updated by the Firebase listener, no need to set here
                } else {
                    energyLabel.innerText = "Custom Range";
                    isViewingHistory = true;
                    // Fetch real energy history from Firebase
                    const startEpochDay = Math.floor(new Date(start).getTime() / 1000 / 86400);
                    const endEpochDay = Math.floor(new Date(end).getTime() / 1000 / 86400);
                    let totalWh = 0;
                    let fetched = 0;
                    const totalDays = endEpochDay - startEpochDay + 1;
                    
                    if (totalDays <= 0 || totalDays > 365) {
                        energyTotal.innerHTML = '--<span class="unit">kWh</span>';
                        return;
                    }
                    
                    energyTotal.innerHTML = '...<span class="unit">kWh</span>';
                    
                    for (let d = startEpochDay; d <= endEpochDay; d++) {
                        database.ref("/Energy_History/Day_" + d).once("value").then(snap => {
                            if (snap.exists()) totalWh += snap.val();
                            fetched++;
                            if (fetched >= totalDays) {
                                energyTotal.innerHTML = (totalWh / 1000).toFixed(2) + '<span class="unit">kWh</span>';
                            }
                        }).catch(() => {
                            fetched++;
                            if (fetched >= totalDays) {
                                energyTotal.innerHTML = (totalWh / 1000).toFixed(2) + '<span class="unit">kWh</span>';
                            }
                        });
                    }
                }
            }
        }
        
        startDateInput.addEventListener('change', handleDateChange);
        endDateInput.addEventListener('change', handleDateChange);
    }
});


// =========================================
// SMART SCHEDULING LOGIC
// =========================================
let schedules = [];
let scheduleIdCounter = 0;

function openSchedulePopup(e) {
    if(e) e.stopPropagation();
    document.getElementById("schedule-modal").style.display = "flex";
}

function closeSchedulePopup() {
    document.getElementById("schedule-modal").style.display = "none";
}

function openViewSchedules(e) {
    if(e) e.stopPropagation();
    renderScheduleList();
    document.getElementById("view-schedules-modal").style.display = "flex";
}

function closeViewSchedules() {
    document.getElementById("view-schedules-modal").style.display = "none";
}

// Close modals if clicked outside
window.onclick = function(event) {
    if (event.target.classList.contains("modal")) {
        event.target.style.display = "none";
    }
}



function saveSchedule() {

    if (isSystemLocked) {
        showToast("Error: System is Locked!");
        return;
    }

    const isOffline = (Math.floor(Date.now() / 1000) - lastHeartbeat) > 60;
    if (isOffline) {
        showToast("Error: System is Offline!");
        return;
    }

    const device = document.querySelector(".device-option.selected").dataset.value;
    const isActionOn = document.getElementById("sched-action").checked;
    const delayMins = parseInt(document.getElementById("sched-time").value);
    const currentEpoch = Math.floor(Date.now() / 1000);
    const targetEpoch = currentEpoch + (delayMins * 60);
    
    const taskForFirebase = { device: device, action: isActionOn, epoch: targetEpoch };
    database.ref("/Schedules").push(taskForFirebase).catch(e => showToast("Error: " + e.message));
    
    closeSchedulePopup();
    showToast(`Schedule saved! ESP32 will turn ${device} ${isActionOn ? "ON" : "OFF"} in ${delayMins} mins.`);
}




// Listen to Schedules from Firebase
database.ref("/Schedules").on("value", (snapshot) => {
    schedules = [];
    snapshot.forEach((child) => {
        const data = child.val();
        schedules.push({
            id: child.key,
            device: data.device,
            action: data.action ? "on" : "off",
            executeTime: new Date(data.epoch * 1000)
        });
    });
    
    // Sort by execution time
    schedules.sort((a, b) => a.executeTime - b.executeTime);
    
    if(document.getElementById("view-schedules-modal").style.display === "flex") {
        renderScheduleList();
    }
});

// Remove manual schedule deletion mock, make it use Firebase
function deleteSchedule(id) {
    
    database.ref("/Schedules/" + id).remove().catch(e => showToast("Error: " + e.message));
    showToast("Schedule Deleted!");
}

function renderScheduleList() {
    const list = document.getElementById("schedule-list");
    list.innerHTML = "";
    
    if(schedules.length === 0) {
        list.innerHTML = "<li class='empty-msg'>No active schedules.</li>";
        return;
    }
    
    schedules.forEach(task => {
        const li = document.createElement("li");
        li.className = "schedule-item";
        
        const deviceName = document.querySelector(`.device-option[data-value="${task.device}"] span`).innerText;
        const timeString = task.executeTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        li.innerHTML = `
            <div class="sched-info">
                <strong>${deviceName}</strong> &rarr; ${task.action.toUpperCase()}
                <div class="sched-time">Executes at ${timeString}</div>
            </div>
            <button class="btn btn-delete" onclick="deleteSchedule('${task.id}')">Delete</button>
        `;
        list.appendChild(li);
    });
}


// Modal Redesign UI Logic
function selectSchedDevice(el) {
    // Remove selected class from all
    const options = document.querySelectorAll('.device-option');
    options.forEach(opt => opt.classList.remove('selected'));
    // Add to clicked
    el.classList.add('selected');
    // Update hidden input
    document.getElementById('sched-device').value = el.getAttribute('data-value');
}

function updateToggleStyle() {
    const isChecked = document.getElementById('sched-action').checked;
    const lblOff = document.getElementById('label-off');
    const lblOn = document.getElementById('label-on');
    
    if(isChecked) {
        lblOn.style.fontWeight = "bold";
        lblOff.style.fontWeight = "normal";
    } else {
        lblOn.style.fontWeight = "normal";
        lblOff.style.fontWeight = "bold";
    }
}

function updateTimeDisplay(val) {
    const display = document.getElementById('time-display');
    if (val < 60) {
        display.innerText = val + " Mins";
    } else {
        const hrs = Math.floor(val / 60);
        const mins = val % 60;
        if(mins === 0) {
            display.innerText = hrs + " Hr" + (hrs > 1 ? "s" : "");
        } else {
            display.innerText = hrs + "h " + mins + "m";
        }
    }
}


function showToast(message) {
    const toast = document.getElementById("toast");
    toast.innerText = message;
    toast.className = "toast show";
    setTimeout(function(){ toast.className = toast.className.replace("show", ""); }, 3000);
}


let latestSettings = {
    voltageOffset: 0.0,
    powerMultiplier: 1.0,
    pirDurationMins: 5,
    batteryHealth: 85
};

// =========================================
// SYSTEM SETTINGS LOGIC
// =========================================
function openSettingsPopup() {
    // Populate form with latest values before opening
    document.getElementById("voltage-offset").value = latestSettings.voltageOffset;
    document.getElementById("power-multiplier").value = latestSettings.powerMultiplier;
    
    document.getElementById("motion-duration").value = latestSettings.pirDurationMins;
    updateMotionTimeDisplay(latestSettings.pirDurationMins);
    
    document.getElementById("battery-health").value = latestSettings.batteryHealth;
    const healthDisp = document.getElementById("health-display");
    if(healthDisp) healthDisp.innerText = latestSettings.batteryHealth + "%";

    document.getElementById("settings-modal").style.display = "flex";
}

function closeSettingsPopup() {
    document.getElementById("settings-modal").style.display = "none";
}


function saveSettings() {

    if (isSystemLocked) {
        showToast("Error: System is Locked!");
        return;
    }

    const isOffline = (Math.floor(Date.now() / 1000) - lastHeartbeat) > 60;
    if (isOffline) {
        showToast("Error: System is Offline!");
        return;
    }

    const offset = document.getElementById("voltage-offset").value;
    const powerMult = document.getElementById("power-multiplier").value;
    const duration = document.getElementById("motion-duration").value;
    const health = document.getElementById("battery-health").value;
    
    database.ref("/Settings").update({
        voltageOffset: parseFloat(offset),
        powerMultiplier: parseFloat(powerMult),
        pirDurationMins: parseInt(duration),
        batteryHealth: parseInt(health)
    }).catch(e => showToast("Error: " + e.message));
    
    closeSettingsPopup();
    showToast("Settings saved successfully!");
}

function updateMotionTimeDisplay(val) {
    document.getElementById("motion-time-display").innerText = val + " Mins";
}


function triggerFanEmergency(e) {
    if(e) e.stopPropagation();

    if (isSystemLocked) {
        showToast("Error: System is Locked!");
        return;
    }

    const isOffline = (Math.floor(Date.now() / 1000) - lastHeartbeat) > 60;
    if (isOffline) {
        showToast("Error: System is Offline!");
        return;
    }

    
    // Write to Firebase
    const card = document.getElementById("fan-card");
    if (card) card.classList.add("loading");

    // Register pending action for hardware confirmation
    pendingActions["fan"] = setTimeout(() => {
        delete pendingActions["fan"];
        if (card) card.classList.remove("loading");
        showToast("Error: Cloud did not respond.");
    }, 15000);

    database.ref("/device/command").update({"fanEmergency": true})
        .catch(e => {
            if (pendingActions["fan"]) {
                clearTimeout(pendingActions["fan"]);
                delete pendingActions["fan"];
            }
            if (card) card.classList.remove("loading");
            showToast("Error: " + e.message);
        });

    closeEmergencyModal();
}




function toggleOutsideLight(e) {
    if(e) e.stopPropagation();
    if (isSystemLocked) {
        showToast("Error: System is Locked!");
        return;
    }
    const isOffline = (Math.floor(Date.now() / 1000) - lastHeartbeat) > 60;
    if (isOffline) { showToast("Error: System is Offline!"); return; }
    
    const card = document.getElementById("light2-card");
    if (card.classList.contains("loading")) return;
    
    card.classList.add("loading");
    
    if (outsideLightMode === "auto") {
        database.ref("/device/command").update({"outsideLightForce": true}).then(() => {
            card.classList.remove("loading");
        }).catch(e => {
            card.classList.remove("loading");
            showToast("Error: " + e.message);
        });
    } else {
        database.ref("/device/command").update({"outsideLightAuto": true}).then(() => {
            card.classList.remove("loading");
        }).catch((err) => {
            card.classList.remove("loading");
            showToast("Error: " + err.message);
        });
    }
}





// =========================================
// SYSTEM ONLINE/OFFLINE STATUS LOGIC
// =========================================
let lastHeartbeat = 0;
let isViewingHistory = false; // Prevents 5-sec realtime update from overwriting the energy chart/history selection // Start at 0 so it immediately shows offline until real data arrives

// In final integration, call this inside the Firebase on() callback
function updateHeartbeat(epochFromFirebase) {
    lastHeartbeat = epochFromFirebase;
}

setInterval(() => {
    const currentEpoch = Math.floor(Date.now() / 1000);
    const diff = currentEpoch - lastHeartbeat;
    
    const statusText = document.querySelector(".status-text");
    const pulseDot = document.querySelector(".pulse-dot");
    const pulseRing = document.querySelector(".pulse-ring");
    const statusCard = document.querySelectorAll(".status-type")[0]; // The online card
    
    if (diff > 60) {
        statusText.innerText = "Offline";
        statusText.style.color = "#e74c3c";
        pulseDot.style.background = "#e74c3c";
        pulseRing.style.display = "none";
        statusCard.style.boxShadow = "0 8px 30px rgba(231, 76, 60, 0.15)";
        
        statusCard.style.boxShadow = "0 8px 30px rgba(231, 76, 60, 0.15)";
        statusCard.style.borderColor = "rgba(231, 76, 60, 0.3)";
        
        // Wipe stale data
        document.getElementById("battery-text").innerText = "--%";
        document.getElementById("battery-fill").setAttribute("width", 0);
        document.getElementById("battery-voltage").innerText = "-- V";
        document.getElementById("battery-time").innerText = "Offline";
        document.getElementById("current-power").innerHTML = `--<span class="unit">W</span>`;
        document.getElementById("energy-total").innerHTML = `--<span class="unit">kWh</span>`;
        document.getElementById("temp-value").innerHTML = `--<span class="temp-unit">&deg;C</span>`;
        const tempFill = document.getElementById("temp-fill");
        if (tempFill) {
            tempFill.setAttribute("height", 0);
            tempFill.setAttribute("y", 90);
        }
        const humOffEl = document.getElementById("hum-value");
        if (humOffEl) humOffEl.innerText = "--%";

    } else {
        statusText.innerText = "Online";
        statusText.style.color = "#2ecc71";
        pulseDot.style.background = "#2ecc71";
        pulseRing.style.display = "block";
        statusCard.style.boxShadow = "0 8px 30px rgba(46, 204, 113, 0.15)";
        statusCard.style.borderColor = "rgba(46, 204, 113, 0.3)";
    }
}, 10000);
