
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

// =========================================
// ON-DEMAND PRESENCE SENSING (Tab Focus / Background)
// =========================================
const webActiveRef = database.ref("/device/command/webActive");

function updateWebPresence() {
    const isVisible = (document.visibilityState === 'visible');
    if (isVisible) {
        webActiveRef.set(true);
        webActiveRef.onDisconnect().set(false);
    } else {
        webActiveRef.set(false);
    }
}

document.addEventListener("visibilitychange", updateWebPresence);
window.addEventListener("focus", updateWebPresence);
window.addEventListener("blur", updateWebPresence);
window.addEventListener("pagehide", () => webActiveRef.set(false));
window.addEventListener("beforeunload", () => webActiveRef.set(false));
updateWebPresence();

// =========================================
// LOCAL STORAGE CACHING & FAST RESTORE (0-Delay)
// =========================================
function loadCachedState() {
    try {
        const cachedSensors = localStorage.getItem("ha_sensors");
        if (cachedSensors) {
            applySensorData(JSON.parse(cachedSensors));
        }
        const cachedDevice = localStorage.getItem("ha_device_state");
        if (cachedDevice) {
            applyDeviceState(JSON.parse(cachedDevice));
        }
        const cachedHb = localStorage.getItem("ha_heartbeat");
        if (cachedHb) {
            lastHeartbeat = parseInt(cachedHb, 10);
            updateStatusUI();
        }
    } catch (e) {
        console.warn("Could not load from localStorage", e);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadCachedState);
} else {
    loadCachedState();
}

// 1. SENSOR DATA LISTENER (Lightweight & Modular)
database.ref("/Sensor_Data").on("value", (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    try {
        localStorage.setItem("ha_sensors", JSON.stringify(data));
    } catch (e) {}
    applySensorData(data);
});

function applySensorData(sensors) {
    if (!sensors) return;

    if (sensors.Last_Heartbeat !== undefined) {
        updateHeartbeat(sensors.Last_Heartbeat);
    }

    const currentEpoch = Math.floor(Date.now() / 1000);
    const isOffline = lastHeartbeat > 0 && (currentEpoch - lastHeartbeat) > 75;
    if (isOffline) return; // Wait for online update

    if (sensors.Battery_V !== undefined) {
        const el = document.getElementById("battery-voltage");
        if (el) el.innerText = Number(sensors.Battery_V).toFixed(1) + "V";
    }
    if (sensors.Battery_Pct !== undefined) {
        updateBattery(sensors.Battery_Pct, sensors.Battery_V);
    }
    if (sensors.TimeLeft_Mins !== undefined) {
        const timeEl = document.getElementById("battery-time");
        if (timeEl) {
            if (sensors.TimeLeft_Mins === -1) {
                timeEl.innerText = "Grid ON / Stable";
            } else {
                const hrs = Math.floor(sensors.TimeLeft_Mins / 60);
                const mins = sensors.TimeLeft_Mins % 60;
                timeEl.innerText = `${hrs}h ${mins}m left`;
            }
        }
    }
    if (sensors.Power_W !== undefined) {
        const pEl = document.getElementById("current-power");
        if (pEl) pEl.innerHTML = Math.round(sensors.Power_W) + `<span class="unit">W</span>`;
    }
    if (sensors.Energy_Today_Wh !== undefined && !isViewingHistory) {
        const eEl = document.getElementById("energy-total");
        if (eEl) eEl.innerHTML = (sensors.Energy_Today_Wh / 1000).toFixed(2) + `<span class="unit">kWh</span>`;
    }
    if (sensors.Temperature !== undefined) {
        const tempEl = document.getElementById("temp-value");
        if (tempEl) tempEl.innerHTML = Number(sensors.Temperature).toFixed(1) + `&deg;C`;
        updateTemperature(sensors.Temperature);
    }
    if (sensors.Humidity !== undefined) {
        const humEl = document.getElementById("hum-value");
        if (humEl) humEl.innerText = Math.round(sensors.Humidity) + `%`;
    }
}

// 2. DEVICE STATE LISTENER (Instant Event Sync)
database.ref("/device/state").on("value", (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    try {
        localStorage.setItem("ha_device_state", JSON.stringify(data));
    } catch (e) {}
    applyDeviceState(data);
});

// 3. MASTER KILL SWITCH LISTENER (External System: /System_Status/Master_Block)
database.ref("/System_Status/Master_Block").on("value", (snapshot) => {
    if (snapshot.exists()) {
        const val = snapshot.val();
        const locked = (val === true || val === 1 || val === "true" || val === "1");
        isSystemLocked = locked;
        const overlay = document.getElementById("lockdown-overlay");
        if (overlay) overlay.style.display = isSystemLocked ? "flex" : "none";
        const grid = document.querySelector(".device-grid");
        if (grid) {
            if (isSystemLocked) grid.classList.add("locked-system");
            else grid.classList.remove("locked-system");
        }
    }
});

function applyDeviceState(state) {
    if (!state) return;

    // SYSTEM LOCKDOWN
    if (state.System_Lock !== undefined) {
        isSystemLocked = state.System_Lock;
        const overlay = document.getElementById("lockdown-overlay");
        if (overlay) {
            overlay.style.display = isSystemLocked ? "flex" : "none";
        }
        const grid = document.querySelector(".device-grid");
        if (grid) {
            if (isSystemLocked) grid.classList.add("locked-system");
            else grid.classList.remove("locked-system");
        }
    }

    // Only apply Firebase state if we haven't clicked a button in the last 2 seconds
    const timeSinceClick = Date.now() - window.lastClickTime;
    if (timeSinceClick > 2000) {
        if (state.fanState !== undefined) updateDeviceCard("fan", state.fanState);
        if (state.insideLightState !== undefined) updateDeviceCard("light1", state.insideLightState);
        if (state.outsideLightState !== undefined) updateDeviceCard("light2", state.outsideLightState);
    }

    if (state.outsideLightMode !== undefined) {
        outsideLightMode = state.outsideLightMode;
        const switchTrack = document.getElementById("bike-switch-track");
        const modeBadge = document.getElementById("light2-mode");

        if (switchTrack) {
            switchTrack.classList.remove("pos-left", "pos-center", "pos-right", "motion-active");
            if (outsideLightMode === "force_off") {
                switchTrack.classList.add("pos-left");
            } else if (outsideLightMode === "force_on" || outsideLightMode === "force") {
                switchTrack.classList.add("pos-right");
            } else {
                switchTrack.classList.add("pos-center");
                if (state.outsideLightState === true) {
                    switchTrack.classList.add("motion-active");
                }
            }
        }

        if (modeBadge) {
            if (outsideLightMode === "force_off") {
                modeBadge.innerText = "FORCE OFF";
                modeBadge.className = "mode-badge force-mode";
            } else if (outsideLightMode === "force_on" || outsideLightMode === "force") {
                modeBadge.innerText = "FORCE ON";
                modeBadge.className = "mode-badge force-mode";
            } else {
                if (state.outsideLightState === true) {
                    modeBadge.innerText = "Motion Detected";
                    modeBadge.className = "mode-badge auto-mode";
                    modeBadge.style.backgroundColor = "#ff9800";
                } else {
                    modeBadge.innerText = "Auto";
                    modeBadge.className = "mode-badge auto-mode";
                    modeBadge.style.backgroundColor = "";
                }
            }
        }
    }

    if (state.outsideLightForceEnd !== undefined) {
        outsideLightForceEnd = state.outsideLightForceEnd;
    }
    if (state.fanEmergencyEnd !== undefined) {
        fanEmergencyEnd = state.fanEmergencyEnd;
    }
}

// 3. SETTINGS LISTENER
database.ref("/Settings").on("value", (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    if (data.voltageOffset !== undefined) latestSettings.voltageOffset = data.voltageOffset;
    if (data.powerMultiplier !== undefined) latestSettings.powerMultiplier = data.powerMultiplier;
    if (data.pirDurationMins !== undefined) latestSettings.pirDurationMins = data.pirDurationMins;
    if (data.batteryHealth !== undefined) latestSettings.batteryHealth = data.batteryHealth;
});

// Variables for fan inertia animation
let fanSpeed = 0;
const MAX_SPEED = 12.0; // Max speed for video playback
let fanInterval;



// =========================================
// PENDING HARDWARE ACTIONS (Feedback Loop)
// =========================================
let pendingActions = {};

window.lastClickTime = 0;

function toggleDevice(device) {
    window.lastClickTime = Date.now();
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
        // Optimistic UI Update (Instant feedback)
        updateDeviceCard(device, expectedState);
        
        database.ref(basePath).update(updateObj)
            .catch((error) => {
                showToast("Error: " + error.message);
                updateDeviceCard(device, currentState); // Revert on failure
            });
    }
}


// Update device UI state
function updateDeviceCard(device, state) {
    const card = document.getElementById(device + "-card");
    if (!card) return;
    
    if (state) {
        card.classList.add("active");
        if (device === "fan") {
            const video = document.getElementById('fan-video');
            if (!video || video.paused || fanSpeed < 1.0) {
                startFan();
            }
        }
    } else {
        card.classList.remove("active");
        if (device === "fan") {
            const video = document.getElementById('fan-video');
            if (video && (!video.paused || fanSpeed > 0)) {
                stopFan();
            }
        }
    }
}

function startFan() {
    const video = document.getElementById('fan-video');
    if (!video) return;
    
    clearInterval(fanInterval);
    video.muted = true;
    
    const playPromise = video.play();
    if (playPromise !== undefined) {
        playPromise.catch((e) => {
            console.log('Autoplay waiting for user gesture:', e);
            const retryOnInteraction = () => {
                const card = document.getElementById('fan-card');
                if (card && card.classList.contains('active')) {
                    video.play().catch(() => {});
                }
                document.removeEventListener('click', retryOnInteraction);
                document.removeEventListener('touchstart', retryOnInteraction);
            };
            document.addEventListener('click', retryOnInteraction, { once: true });
            document.addEventListener('touchstart', retryOnInteraction, { once: true });
        });
    }
    
    if (fanSpeed < 1.0) fanSpeed = 1.0;
    
    // Gradually increase speed
    fanInterval = setInterval(() => {
        fanSpeed += 0.2;
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
        fanSpeed -= 0.1; 
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
    const fanCard = document.getElementById('fan-card');
    
    // Only pause video if fan is NOT active!
    if (fanCard && fanCard.classList.contains('active')) {
        startFan();
    } else {
        if (video) {
            video.pause();
            video.playbackRate = 0.1; 
        }
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
        
        // Light2 Timer (for Force ON and Force OFF)
        const light2TimerEl = document.getElementById("light2-timer");
        if (light2TimerEl) {
            const isForced = (outsideLightMode === "force" || outsideLightMode === "force_on" || outsideLightMode === "force_off");
            if (isForced && outsideLightForceEnd > currentEpoch) {
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
    const authModal = document.getElementById("settings-auth-modal");
    const pwdInput = document.getElementById("settings-password-input");
    const errorMsg = document.getElementById("settings-auth-error");
    if (pwdInput) pwdInput.value = "";
    if (errorMsg) errorMsg.style.display = "none";
    if (authModal) {
        authModal.style.display = "flex";
        setTimeout(() => { if (pwdInput) pwdInput.focus(); }, 100);
    } else {
        showActualSettingsModal();
    }
}

function closeSettingsAuthPopup() {
    const authModal = document.getElementById("settings-auth-modal");
    if (authModal) authModal.style.display = "none";
}

function verifySettingsPassword() {
    const pwdInput = document.getElementById("settings-password-input");
    const errorMsg = document.getElementById("settings-auth-error");
    const entered = pwdInput ? pwdInput.value.trim() : "";
    if (entered === "admin123") {
        closeSettingsAuthPopup();
        showActualSettingsModal();
    } else {
        if (errorMsg) {
            errorMsg.innerText = "गलत पासवर्ड! कृपया दोबारा प्रयास करें।";
            errorMsg.style.display = "block";
        }
        if (pwdInput) {
            pwdInput.value = "";
            pwdInput.focus();
        }
    }
}

function showActualSettingsModal() {
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
        fetch("/api/toggle_emerg", { method: "POST" })
            .then(() => showToast("Emergency Mode sent!"))
            .catch(() => showToast("Failed to reach device"));
        return;
    }

    document.getElementById("emergency-modal").style.display = "flex";
}

function closeEmergencyModal() {
    document.getElementById("emergency-modal").style.display = "none";
}

function startEmergency() {
    window.lastClickTime = Date.now();
    if (isSystemLocked) {
        showToast("Error: System is Locked!");
        return;
    }

    const isOffline = (Math.floor(Date.now() / 1000) - lastHeartbeat) > 60;
    if (isOffline) {
        showToast("Error: System is Offline!");
        return;
    }

    database.ref("/device/command").update({"fanEmergency": true})
        .catch(e => {
            showToast("Error: " + e.message);
        });

    closeEmergencyModal();
}




function handleSwitchModeClick(targetMode, e) {
    if (e) e.stopPropagation();
    window.lastClickTime = Date.now();

    if (isSystemLocked) {
        showToast("Error: System is Locked!");
        return;
    }
    const isOffline = (Math.floor(Date.now() / 1000) - lastHeartbeat) > 60;
    if (isOffline) {
        showToast("Error: System is Offline!");
        return;
    }

    // If already in auto and clicked auto, do nothing (no-op)
    if (targetMode === "auto" && outsideLightMode === "auto") {
        return;
    }

    outsideLightMode = targetMode;

    const switchTrack = document.getElementById("bike-switch-track");
    if (switchTrack) {
        switchTrack.classList.remove("pos-left", "pos-center", "pos-right", "motion-active");
        if (targetMode === "force_off") {
            switchTrack.classList.add("pos-left");
            updateDeviceCard("light2", false);
        } else if (targetMode === "force_on") {
            switchTrack.classList.add("pos-right");
            updateDeviceCard("light2", true);
        } else {
            switchTrack.classList.add("pos-center");
            updateDeviceCard("light2", false);
        }
    }

    let updateObj = {};
    if (targetMode === "force_on") {
        updateObj = {
            "outsideLightForceOn": true,
            "outsideLightForceOff": false,
            "outsideLightAuto": false,
            "outsideLightMode": "force_on",
            "outsideLightState": true
        };
        showToast("Outside Light: FORCE ON (1 Hr)");
    } else if (targetMode === "force_off") {
        updateObj = {
            "outsideLightForceOff": true,
            "outsideLightForceOn": false,
            "outsideLightAuto": false,
            "outsideLightMode": "force_off",
            "outsideLightState": false
        };
        showToast("Outside Light: FORCE OFF (1 Hr Mute)");
    } else {
        updateObj = {
            "outsideLightAuto": true,
            "outsideLightForceOn": false,
            "outsideLightForceOff": false,
            "outsideLightMode": "auto",
            "outsideLightState": false
        };
        showToast("Outside Light: AUTO Mode Active");
    }

    database.ref("/device/command").update(updateObj)
        .catch(err => showToast("Error: " + err.message));
}

function toggleOutsideLight(e) {
    if (outsideLightMode === "auto") {
        handleSwitchModeClick("force_on", e);
    } else {
        handleSwitchModeClick("auto", e);
    }
}

// Swipe Support for Bike Indicator Switch on light2-card
window.addEventListener('DOMContentLoaded', () => {
    const lightCard = document.getElementById('light2-card');
    if (!lightCard) return;

    let touchStartX = 0;
    let touchStartY = 0;

    lightCard.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].clientX;
        touchStartY = e.changedTouches[0].clientY;
    }, { passive: true });

    lightCard.addEventListener('touchend', (e) => {
        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        const dx = touchEndX - touchStartX;
        const dy = touchEndY - touchStartY;

        // If horizontal swipe detected (minimum 35px, and dx > dy)
        if (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy)) {
            if (dx > 0) {
                handleSwitchModeClick('force_on');
            } else {
                handleSwitchModeClick('force_off');
            }
        }
    }, { passive: true });
});





// =========================================
// SYSTEM ONLINE/OFFLINE STATUS LOGIC
// =========================================
let lastHeartbeat = 0;
let isViewingHistory = false; // Prevents realtime update from overwriting history selection

function updateHeartbeat(epochFromFirebase) {
    lastHeartbeat = Number(epochFromFirebase);
    try {
        localStorage.setItem("ha_heartbeat", lastHeartbeat.toString());
    } catch (e) {}
    updateStatusUI();
}

function updateStatusUI() {
    const statusText = document.querySelector(".status-text");
    const pulseDot = document.querySelector(".pulse-dot");
    const pulseRing = document.querySelector(".pulse-ring");
    const statusCard = document.querySelectorAll(".status-type")[0]; // The online card
    if (!statusText || !pulseDot || !pulseRing || !statusCard) return;

    if (lastHeartbeat === 0) {
        statusText.innerText = "Connecting...";
        statusText.style.color = "#0284c7";
        pulseDot.style.background = "#0284c7";
        pulseRing.style.display = "none";
        statusCard.style.boxShadow = "0 8px 30px rgba(2, 132, 199, 0.15)";
        statusCard.style.borderColor = "rgba(2, 132, 199, 0.3)";
        return;
    }

    const currentEpoch = Math.floor(Date.now() / 1000);
    const diff = currentEpoch - lastHeartbeat;

    if (diff > 75) {
        statusText.innerText = "Offline";
        statusText.style.color = "#e74c3c";
        pulseDot.style.background = "#e74c3c";
        pulseRing.style.display = "none";
        statusCard.style.boxShadow = "0 8px 30px rgba(231, 76, 60, 0.15)";
        statusCard.style.borderColor = "rgba(231, 76, 60, 0.3)";

        const timeEl = document.getElementById("battery-time");
        if (timeEl) timeEl.innerText = "Offline";
    } else {
        statusText.innerText = "Online";
        statusText.style.color = "#2ecc71";
        pulseDot.style.background = "#2ecc71";
        pulseRing.style.display = "block";
        statusCard.style.boxShadow = "0 8px 30px rgba(46, 204, 113, 0.15)";
        statusCard.style.borderColor = "rgba(46, 204, 113, 0.3)";
    }
}

setInterval(updateStatusUI, 5000);


// =========================================
// SYSTEM DIAGNOSTICS & RESET HISTORY
// =========================================
function openDiagnosticsPopup() {
    const isOffline = (Math.floor(Date.now() / 1000) - lastHeartbeat) > 60;
    const statusVal = document.getElementById("diag-status-val");
    if (statusVal) {
        statusVal.innerText = isOffline ? "Offline" : "Online";
        statusVal.style.color = isOffline ? "#e74c3c" : "#2ecc71";
    }
    document.getElementById("diagnostics-modal").style.display = "flex";
}

function closeDiagnosticsPopup() {
    document.getElementById("diagnostics-modal").style.display = "none";
}

// Close modal if user clicks outside modal content
window.addEventListener('click', (e) => {
    const diagModal = document.getElementById("diagnostics-modal");
    if (e.target === diagModal) {
        closeDiagnosticsPopup();
    }
});

function clearResetHistory() {
    if (confirm("Are you sure you want to clear the reset history log?")) {
        database.ref("/Diagnostics/Reset_History").remove()
            .then(() => {
                showToast("Reset history cleared!");
            })
            .catch(err => showToast("Error: " + err.message));
    }
}

// Helper to escape HTML and prevent injection
function escapeHtmlText(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Realtime Listener for Diagnostics & Reset History
database.ref("/Diagnostics").on("value", (snapshot) => {
    const diag = snapshot.val() || {};
    
    // Latest Reset Reason & RAM
    if (diag.Last_Reset) {
        const last = diag.Last_Reset;
        const reasonEl = document.getElementById("diag-latest-reason");
        const timeEl = document.getElementById("diag-latest-time");
        const ramEl = document.getElementById("diag-ram-val");

        if (reasonEl) reasonEl.innerText = last.reason || "Unknown";
        if (ramEl && last.freeHeap) ramEl.innerText = Math.round(last.freeHeap / 1024) + " KB";

        if (timeEl && last.timestamp) {
            const d = new Date(last.timestamp * 1000);
            timeEl.innerText = d.toLocaleString('en-IN', {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: true
            });
        }
    }

    // Reset History List
    const historyList = document.getElementById("reset-history-list");
    const countVal = document.getElementById("diag-count-val");
    if (!historyList) return;

    if (!diag.Reset_History) {
        historyList.innerHTML = '<li class="empty-msg">No reset logs available.</li>';
        if (countVal) countVal.innerText = "0";
        return;
    }

    const items = [];
    for (let k in diag.Reset_History) {
        items.push({ id: k, ...diag.Reset_History[k] });
    }

    // Sort newest first
    items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    if (countVal) countVal.innerText = items.length;

    // Limit to last 20
    const displayItems = items.slice(0, 20);

    let html = "";
    displayItems.forEach((entry) => {
        const reason = entry.reason || "Unknown";
        let typeClass = "type-default";
        let badgeClass = "badge-default";
        let badgeLabel = "REBOOT";

        const lower = reason.toLowerCase();
        if (lower.includes("brownout")) {
            typeClass = "type-brownout";
            badgeClass = "badge-brownout";
            badgeLabel = "BROWNOUT";
        } else if (lower.includes("watchdog") || lower.includes("wdt")) {
            typeClass = "type-wdt";
            badgeClass = "badge-wdt";
            badgeLabel = "WATCHDOG";
        } else if (lower.includes("panic") || lower.includes("crash")) {
            typeClass = "type-panic";
            badgeClass = "badge-panic";
            badgeLabel = "CRASH";
        } else if (lower.includes("power-on")) {
            typeClass = "type-poweron";
            badgeClass = "badge-poweron";
            badgeLabel = "POWER ON";
        }

        let timeStr = "--";
        if (entry.timestamp) {
            const d = new Date(entry.timestamp * 1000);
            timeStr = d.toLocaleString('en-IN', {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: true
            });
        }

        html += `
            <li class="reset-history-item ${typeClass}">
                <div class="reset-history-info">
                    <span class="reset-reason-text">${escapeHtmlText(reason)}</span>
                    <span class="reset-time-text">🕒 ${timeStr}</span>
                </div>
                <span class="reset-badge ${badgeClass}">${badgeLabel}</span>
            </li>
        `;
    });

    historyList.innerHTML = html;
});
