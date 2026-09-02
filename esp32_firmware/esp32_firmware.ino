// =============================================================================
//  HOME AUTOMATION SYSTEM - ESP32 Firmware (Firebase RTDB + Advanced BMS)
//  Version: 5.0.0 (New Architecture)
// =============================================================================


#include <WiFi.h>
#include <WiFiMulti.h>
WiFiMulti wifiMulti;

#include <WebServer.h>
#include "offline_html.h"
WebServer server(80);

#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <addons/RTDBHelper.h>
#include <DHT.h>

#include <WiFiUdp.h>
#include <NTPClient.h>

WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 19800, 60000); // UTC+5:30 (IST)


// =============================================================================
//  CREDENTIALS
// =============================================================================
#define WIFI_SSID       "vivo 1811"
#define WIFI_PASS       "12344321"
#define AP_SSID         "HomeAuto_ESP32"
#define AP_PASS         "home1234"

#define FIREBASE_API_KEY      "AIzaSyAnp0VTMBMME0WtJGHnuVLquIPeMjEfOcE"
#define FIREBASE_DATABASE_URL "https://myhomeauto-9122d-default-rtdb.firebaseio.com/"

// =============================================================================
//  PIN DEFINITIONS (ESP32)
// =============================================================================
#define RELAY_FAN           26
#define RELAY_OUTSIDE_LIGHT 27
#define RELAY_INSIDE_LIGHT  14
#define DHT_PIN             4
#define DHT_TYPE            DHT11
#define PIR_PIN             16
#define BATTERY_PIN         35
#define ACS712_PIN          34

// =============================================================================
//  GLOBAL OBJECTS & STATE
// =============================================================================
FirebaseData fbdo;          // Used in loop() on Core 1
FirebaseData fbdoTask;      // Used in TaskSensorsAndFirebase on Core 0
FirebaseData streamFbdo;    // Used for Firebase stream
FirebaseAuth auth;
FirebaseConfig config;

DHT dht(DHT_PIN, DHT_TYPE);

// Task Handles
TaskHandle_t TaskSensorHandle;

// Relay States (Active LOW)
bool fanState = false;
bool outsideLightState = false;
bool systemLocked = false;
bool insideLightState = false;

// Sensor Readings
float current_A = 0.0;
float power_W = 0.0;
float dailyEnergy_Wh = 0.0;
uint32_t currentDayId = 0;
float battery_V = 0.0;
float temp_C = 0.0;
float hum_P = 0.0;
int battery_Pct = 0;
uint32_t lastEnergyTickMs = 0;

// =============================================================================
//  SETTINGS FROM FIREBASE (Dynamic)
// =============================================================================
float voltageOffset = 0.0f;           // From UI settings
float batteryHealth = 0.85f;          // From UI Settings (10-100%)
uint32_t pirHoldMs = 5 * 60000UL;     // Default 5 mins

// =============================================================================
//  BATTERY MANAGEMENT SYSTEM (BMS) CONSTANTS
// =============================================================================
// Piecewise linear V->% table for 12V Lead-Acid battery.
const float voltageTable[][2] = {
  { 11.0f,   0.0f },
  { 11.5f,   5.0f },
  { 11.8f,  15.0f },
  { 12.0f,  30.0f },
  { 12.2f,  50.0f },
  { 12.4f,  70.0f },
  { 12.6f,  85.0f },
  { 12.7f, 100.0f }
};
const int voltageTableSize = sizeof(voltageTable) / sizeof(voltageTable[0]);

// Hysteresis thresholds (%)
#define BATTERY_FAN_LOCK_BELOW    40
#define BATTERY_FAN_UNLOCK_ABOVE  60


bool fanEmergencyActive = false;
uint32_t fanEmergencyStartMs = 0;
#define FAN_EMERGENCY_DURATION_MS 600000UL // 10 mins
#define BATTERY_DEAD_BELOW 15 // Emergency not allowed below 15%

bool fanHysteresisLock  = false;
bool fanWasOnBeforeLock = false;

// PIR State
bool pirMotionDetected  = false;
uint32_t pirLastMotionMs = 0;

int outsideForceMode = 0; // 0=Auto, 1=ForceON, 2=ForceOFF
uint32_t outsideForceStartMs = 0;
uint32_t currentForceDurationMs = 3600000UL;

// Stream callback flags (set in callback, processed in loop)
volatile bool flagResetOutsideLightForce = false;
volatile bool flagResetOutsideLightAuto = false;
volatile bool flagResetFanEmergency = false;

// Hardware confirmation system - per device
struct DeviceConfirmData {
    volatile bool pending;
    bool state;
    bool success;
    char reason[48];
};
DeviceConfirmData confirmFan    = {false, false, false, ""};
DeviceConfirmData confirmLight1 = {false, false, false, ""};
DeviceConfirmData confirmLight2 = {false, false, false, ""};

// Skip flags to prevent processing our own state reverts
volatile bool skipNextFanState    = false;
volatile bool skipNextLight1State = false;
volatile bool skipNextLight2State = false;


// =============================================================================
//  HELPER FUNCTIONS
// =============================================================================
void setRelay(uint8_t pin, bool state) {
  digitalWrite(pin, state ? LOW : HIGH);
}

float voltageToPct(float v) {
  if (v <= voltageTable[0][0]) return voltageTable[0][1];
  if (v >= voltageTable[voltageTableSize - 1][0]) return voltageTable[voltageTableSize - 1][1];

  for (int i = 0; i < voltageTableSize - 1; i++) {
    float v0 = voltageTable[i][0], v1 = voltageTable[i+1][0];
    float p0 = voltageTable[i][1], p1 = voltageTable[i+1][1];
    if (v >= v0 && v <= v1) {
      return p0 + (p1 - p0) * ((v - v0) / (v1 - v0));
    }
  }
  return 0.0f;
}

// =============================================================================
//  FIREBASE STREAM CALLBACK (Handles Website Button Clicks & Settings)
// =============================================================================

void streamCallback(MultiPathStream data) {
  // Relay Controls
  if (data.get("/device/state/fanState")) {
    bool val = (data.value == "true" || data.value == "1");
    if (skipNextFanState) {
      skipNextFanState = false;
      Serial.println("[STREAM] Fan state revert acknowledged, skipping");
    } else if (systemLocked) {
      confirmFan.state = fanState;
      confirmFan.success = false;
      strncpy(confirmFan.reason, "System is Locked", sizeof(confirmFan.reason));
      confirmFan.pending = true;
      Serial.println("[STREAM] Fan command rejected (System Locked)");
    } else if (!fanHysteresisLock || !val) { // Allow turning OFF even if locked
      fanState = val;
      setRelay(RELAY_FAN, fanState);
      confirmFan.state = fanState;
      confirmFan.success = true;
      confirmFan.reason[0] = '\0';
      confirmFan.pending = true;
      Serial.printf("[STREAM] Fan -> %s (confirmed)\n", fanState ? "ON" : "OFF");
    } else {
      confirmFan.state = false;
      confirmFan.success = false;
      snprintf(confirmFan.reason, sizeof(confirmFan.reason), "Battery Low (%d%%)", battery_Pct);
      confirmFan.pending = true;
      Serial.println("[STREAM] Fan command rejected (Battery Lock)");
    }
  }
  
  if (data.get("/device/state/insideLightState")) {
    bool val = (data.value == "true" || data.value == "1");
    if (skipNextLight1State) {
      skipNextLight1State = false;
      Serial.println("[STREAM] Light1 state revert acknowledged, skipping");
    } else if (systemLocked) {
      confirmLight1.state = insideLightState;
      confirmLight1.success = false;
      strncpy(confirmLight1.reason, "System is Locked", sizeof(confirmLight1.reason));
      confirmLight1.pending = true;
      Serial.println("[STREAM] Inside Light rejected (System Locked)");
    } else {
      insideLightState = val;
      setRelay(RELAY_INSIDE_LIGHT, insideLightState);
      confirmLight1.state = insideLightState;
      confirmLight1.success = true;
      confirmLight1.reason[0] = '\0';
      confirmLight1.pending = true;
      Serial.printf("[STREAM] Inside Light -> %s (confirmed)\n", insideLightState ? "ON" : "OFF");
    }
  }
  
  if (data.get("/device/state/outsideLightState")) {
    bool val = (data.value == "true" || data.value == "1");
    if (skipNextLight2State) {
      skipNextLight2State = false;
      Serial.println("[STREAM] Light2 state revert acknowledged, skipping");
    } else if (systemLocked) {
      confirmLight2.state = outsideLightState;
      confirmLight2.success = false;
      strncpy(confirmLight2.reason, "System is Locked", sizeof(confirmLight2.reason));
      confirmLight2.pending = true;
      Serial.println("[STREAM] Outside Light rejected (System Locked)");
    } else {
      outsideLightState = val;
      setRelay(RELAY_OUTSIDE_LIGHT, outsideLightState);
      confirmLight2.state = outsideLightState;
      confirmLight2.success = true;
      confirmLight2.reason[0] = '\0';
      confirmLight2.pending = true;
      Serial.printf("[STREAM] Outside Light -> %s (confirmed)\n", outsideLightState ? "ON" : "OFF");
    }
  }
  
  if (data.get("/outsideLightForce")) {
    bool val = (data.value == "true" || data.value == "1");
    if (val) {
      outsideForceStartMs = millis();
      currentForceDurationMs = 3600000UL; // 1 Hour for manual button
      if (outsideLightState) {
        outsideForceMode = 2; // Was ON, Force OFF
        Serial.println("[STREAM] Outside Light FORCED OFF (1 Hour)");
      } else {
        outsideForceMode = 1; // Was OFF, Force ON
        Serial.println("[STREAM] Outside Light FORCED ON (1 Hour)");
      }
      flagResetOutsideLightForce = true;
    }
  }
  
  if (data.get("/outsideLightAuto")) {
    bool val = (data.value == "true" || data.value == "1");
    if (val) {
      outsideForceMode = 0;
      Serial.println("[STREAM] Outside Light returned to AUTO");
      flagResetOutsideLightAuto = true;
    }
  }
  
  if (data.get("/fanEmergency")) {
    bool val = (data.value == "true" || data.value == "1");
    if (val) {
      if (battery_Pct >= BATTERY_DEAD_BELOW) {
        fanEmergencyActive = true;
        fanEmergencyStartMs = millis();
        fanState = true;
        setRelay(RELAY_FAN, true);
        Serial.println("[STREAM] FAN EMERGENCY ACTIVATED (10 Mins)");
      } else {
        Serial.println("[STREAM] Emergency ignored - Battery Dead");
        flagResetFanEmergency = true;
      }
    }
  }
  
  // Settings
  if (data.get("/Settings/voltageOffset")) {
    voltageOffset = data.value.toFloat();
    Serial.printf("[STREAM] Offset updated: %.2f\n", voltageOffset);
  }
  
  if (data.get("/Settings/pirDurationMins")) {
    pirHoldMs = data.value.toInt() * 60000UL;
    Serial.printf("[STREAM] PIR Duration updated to %d mins\n", data.value.toInt());
  }
  
  if (data.get("/Settings/batteryHealth")) {
    batteryHealth = data.value.toInt() / 100.0f;
    Serial.printf("[STREAM] Battery Health updated to %d%%\n", data.value.toInt());
  }
  
  if (data.get("/System_Lock")) {
    systemLocked = (data.value == "true" || data.value == "1");
    if (systemLocked) {
        Serial.println("[LOCK] System has been LOCKED remotely!");
        setRelay(RELAY_FAN, false);
        setRelay(RELAY_INSIDE_LIGHT, false);
        setRelay(RELAY_OUTSIDE_LIGHT, false);
    } else {
        Serial.println("[LOCK] System UNLOCKED. Restoring previous state.");
        setRelay(RELAY_FAN, fanState);
        setRelay(RELAY_INSIDE_LIGHT, insideLightState);
        setRelay(RELAY_OUTSIDE_LIGHT, outsideLightState);
    }
  }
}


void streamTimeoutCallback(bool timeout) {
  if (timeout) {
    Serial.println("[STREAM] Timeout, restarting...");
  }
}

// =============================================================================
//  FREE_RTOS CORE 0 TASK (SENSORS & FIREBASE UPLOAD)
// =============================================================================
void TaskSensorsAndFirebase(void *pvParameters) {
  for(;;) {
    
    // 1. Read ACS712 Current
    int acsRaw = analogRead(ACS712_PIN);
    float adcVoltage = (acsRaw / 4095.0) * 3.3; 
    float actualSensorVoltage = adcVoltage * 1.5; 
    float current = (actualSensorVoltage - 2.5) / 0.185;
    if (current < 0.1 && current > -0.1) current = 0.0;
    current_A = abs(current);
    power_W = current_A * 230.0; 

    // Energy Calculation using actual elapsed time
    uint32_t nowMs = millis();
    float elapsedSec = (lastEnergyTickMs > 0) ? (nowMs - lastEnergyTickMs) / 1000.0f : 5.0f;
    lastEnergyTickMs = nowMs;
    float energyThisTick = power_W * (elapsedSec / 3600.0f);
    dailyEnergy_Wh += energyThisTick;

    // Midnight Rollover Check (timeClient.update is handled in Core 1)
    uint32_t epoch = timeClient.getEpochTime();
    if (epoch > 1000000000UL) {
      uint32_t todayId = epoch / 86400UL;
      if (currentDayId == 0) {
        currentDayId = todayId; // First sync
      } else if (todayId > currentDayId) {
        // Midnight crossed! Save to history and reset.
        String historyPath = "/Energy_History/Day_" + String(currentDayId);
        Firebase.RTDB.setFloat(&fbdoTask, historyPath, dailyEnergy_Wh);
        vTaskDelay(10 / portTICK_PERIOD_MS); // Yield to prevent WDT
        
        dailyEnergy_Wh = 0;
        currentDayId = todayId;
        Firebase.RTDB.setInt(&fbdoTask, "/Sensor_Data/Current_Day_Id", currentDayId);
        vTaskDelay(10 / portTICK_PERIOD_MS); // Yield to prevent WDT
        Serial.println("[ENERGY] Midnight Rollover. Data saved to history.");
      }
    }
// 2. Read Battery Voltage
    int batRaw = analogRead(BATTERY_PIN);
    float rawBatV = (batRaw / 4095.0) * 3.3 * 4.03; 
    battery_V = rawBatV + voltageOffset; // Apply UI Offset
    battery_Pct = constrain((int)voltageToPct(battery_V), 0, 100);

    
    // BMS Hysteresis Lock
    if (!fanHysteresisLock && battery_Pct <= BATTERY_FAN_LOCK_BELOW) {
      fanWasOnBeforeLock = fanState;
      fanHysteresisLock  = true;
      if (!fanEmergencyActive) {
        fanState = false;
        setRelay(RELAY_FAN, false);
        Serial.println("[BMS] Fan LOCKED - Battery Low");
        Firebase.RTDB.setBool(&fbdoTask, "/device/state/fanState", false);
        vTaskDelay(10 / portTICK_PERIOD_MS); // Yield to prevent WDT
      } else {
        Serial.println("[BMS] Fan lock deferred due to Emergency Mode");
      }
    } else if (fanHysteresisLock && battery_Pct >= BATTERY_FAN_UNLOCK_ABOVE) {
      fanHysteresisLock = false;
      Serial.println("[BMS] Fan UNLOCKED - Restoring user state from Firebase");
      // Read the current desired state from Firebase instead of using stale saved state
      bool desiredFanState = false;
      if (Firebase.RTDB.getBool(&fbdoTask, "/device/state/fanState", &desiredFanState)) {
        fanState = desiredFanState;
        setRelay(RELAY_FAN, fanState);
        Serial.printf("[BMS] Fan restored to %s from Firebase\n", fanState ? "ON" : "OFF");
      } else {
        // Fallback to saved state if Firebase read fails
        if (fanWasOnBeforeLock && !fanEmergencyActive) {
          fanState = true;
          setRelay(RELAY_FAN, true);
          Firebase.RTDB.setBool(&fbdoTask, "/device/state/fanState", true);
        }
      }
      vTaskDelay(10 / portTICK_PERIOD_MS); // Yield to prevent WDT
    }

    // Dead battery overrides emergency
    if (fanEmergencyActive && battery_Pct < BATTERY_DEAD_BELOW) {
      fanEmergencyActive = false;
      fanState = false;
      setRelay(RELAY_FAN, false);
      Serial.println("[BMS] Emergency Cancelled - Battery DEAD");
      Firebase.RTDB.setBool(&fbdoTask, "/fanEmergency", false);
      vTaskDelay(10 / portTICK_PERIOD_MS); // Yield to prevent WDT
      Firebase.RTDB.setBool(&fbdoTask, "/device/state/fanState", false);
      vTaskDelay(10 / portTICK_PERIOD_MS); // Yield to prevent WDT
    }


    // 3. Calculate Remaining Time
    int remainingMins = -1;
    if (battery_V < 13.0f && power_W > 5.0f) {
      float totalEnergy = 150.0f * 12.0f; // 150Ah * 12V = 1800 Wh
      float remainingEnergy = totalEnergy * (battery_Pct / 100.0f);
      float actualUsableEnergy = remainingEnergy * batteryHealth;
      float timeRemainingHours = actualUsableEnergy / power_W;
      remainingMins = (int)(timeRemainingHours * 60.0f);
    }

    // 3. Read DHT
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t)) temp_C = t;
    if (!isnan(h)) hum_P = h;

    // 4. Push to Firebase
    if (Firebase.ready()) {
      FirebaseJson json;
      json.set("Current_A", current_A);
      json.set("Power_W", power_W);
      json.set("Energy_Today_Wh", dailyEnergy_Wh);
      json.set("Battery_V", battery_V);
      json.set("Battery_Pct", battery_Pct);
      json.set("Temperature", temp_C);
      json.set("Humidity", hum_P);
      json.set("TimeLeft_Mins", remainingMins);
      
      uint32_t utcHeartbeat = epoch > 19800 ? epoch - 19800 : epoch;
      json.set("Last_Heartbeat", (int)utcHeartbeat);
      
      Firebase.RTDB.updateNode(&fbdoTask, "/Sensor_Data", &json);
    }

    vTaskDelay(10 / portTICK_PERIOD_MS); // Yield to prevent WDT after heavy Firebase push

      if (systemLocked) {
        // Ignore schedules while locked
      } else // 5. Check and Execute Schedules
      if (epoch > 1000000000UL) {
        if (Firebase.RTDB.getJSON(&fbdoTask, "/Schedules")) {
          vTaskDelay(10 / portTICK_PERIOD_MS); // Yield after heavy getJSON
          FirebaseJson &json = fbdoTask.jsonObject();
          size_t count = json.iteratorBegin();
          String key, value;
          int type = 0;
          
          for (size_t i = 0; i < count; i++) {
            json.iteratorGet(i, type, key, value);
            
            FirebaseJsonData resEpoch, resDev, resAct;
            json.get(resEpoch, key + "/epoch");
            json.get(resDev, key + "/device");
            json.get(resAct, key + "/action");
            
            if (resEpoch.success && resDev.success && resAct.success) {
              uint32_t taskEpoch = resEpoch.to<uint32_t>();
              String device = resDev.to<String>();
              bool action = resAct.to<bool>();
              
              // epoch is IST (UTC+5:30 = +19800). taskEpoch from web is standard UTC.
              uint32_t currentUtcEpoch = epoch > 19800 ? epoch - 19800 : epoch;
              
              if (taskEpoch > 0 && currentUtcEpoch >= taskEpoch) {
                // Time has arrived or passed!
                bool executed = false;
                
                if (systemLocked) {
                    Serial.println("[SCHEDULE] System is LOCKED. Discarding schedule.");
                    executed = true; // Delete it
                } else if (currentUtcEpoch <= taskEpoch + 60) {

                    if (device == "fan" && !fanHysteresisLock) {
                      fanState = action;
                      setRelay(RELAY_FAN, fanState);
                      Firebase.RTDB.setBool(&fbdoTask, "/device/state/fanState", fanState);
                      vTaskDelay(10 / portTICK_PERIOD_MS); // Yield
                      Serial.println("[SCHEDULE] Executed Fan task");
                      executed = true;
                    } else if (device == "light1") {
                      insideLightState = action;
                      setRelay(RELAY_INSIDE_LIGHT, insideLightState);
                      Firebase.RTDB.setBool(&fbdoTask, "/device/state/insideLightState", insideLightState);
                      vTaskDelay(10 / portTICK_PERIOD_MS); // Yield
                      Serial.println("[SCHEDULE] Executed Inside Light task");
                      executed = true;
                    
                    } else if (device == "light2") {
                      outsideForceStartMs = millis();
                      currentForceDurationMs = 600000UL; // 10 Mins for schedule
                      if (action == true) {
                          outsideForceMode = 1; // Force ON
                          Serial.println("[SCHEDULE] Executed Outside Light - FORCED ON (10 Mins)");
                      } else {
                          outsideForceMode = 2; // Force OFF
                          Serial.println("[SCHEDULE] Executed Outside Light - FORCED OFF (10 Mins)");
                      }
                      executed = true;
                    }
                } else {
                    // We missed the 1-minute window (e.g. internet was down)
                    Serial.println("[SCHEDULE] Task missed its 1-minute window. Discarding without running.");
                    executed = true; // Set to true so it gets deleted
                }
                
                // Delete task from Firebase so it does not repeat or linger
                if (executed || fanHysteresisLock) {
                  Firebase.RTDB.deleteNode(&fbdoTask, "/Schedules/" + key);
                  vTaskDelay(10 / portTICK_PERIOD_MS); // Yield after delete
                  Serial.println("[SCHEDULE] Task deleted from Firebase");
                }
              }
            }
          }
          json.iteratorEnd();
        }
      }


    vTaskDelay(5000 / portTICK_PERIOD_MS); // Run every 5 seconds
  }
}

// =============================================================================
//  SETUP
// =============================================================================

void handleRoot() {
  server.send_P(200, "text/html", OFFLINE_HTML);
}

void sendCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

void handleApiStatus() {
  char json[256];
  snprintf(json, sizeof(json),
    "{\"locked\":%s,\"fan\":%s,\"inLight\":%s,\"outLight\":%s,"
    "\"bat_pct\":%d,\"bat_v\":%.1f,\"pow\":%.1f,\"tmp\":%.1f,\"hum\":%.1f}",
    systemLocked ? "true" : "false",
    fanState ? "true" : "false",
    insideLightState ? "true" : "false",
    outsideLightState ? "true" : "false",
    battery_Pct, battery_V, power_W, temp_C, hum_P);
  sendCORS();
  server.send(200, "application/json", json);
}

void handleToggleFan() {
  if (!systemLocked && !fanHysteresisLock) {
    fanState = !fanState;
    setRelay(RELAY_FAN, fanState);
    if(Firebase.ready()) Firebase.RTDB.setBool(&fbdo, "/device/state/fanState", fanState);
  }
  sendCORS();
  server.send(200, "text/plain", "OK");
}

void handleToggleInLight() {
  if (!systemLocked) {
    insideLightState = !insideLightState;
    setRelay(RELAY_INSIDE_LIGHT, insideLightState);
    if(Firebase.ready()) Firebase.RTDB.setBool(&fbdo, "/device/state/insideLightState", insideLightState);
  }
  sendCORS();
  server.send(200, "text/plain", "OK");
}

void handleToggleOutLight() {
  if (!systemLocked) {
    outsideLightState = !outsideLightState;
    setRelay(RELAY_OUTSIDE_LIGHT, outsideLightState);
    if(Firebase.ready()) Firebase.RTDB.setBool(&fbdo, "/device/state/outsideLightState", outsideLightState);
  }
  sendCORS();
  server.send(200, "text/plain", "OK");
}

void handleFanEmerg() {
  if (!systemLocked) {
    fanEmergencyActive = true;
    fanEmergencyStartMs = millis();
    fanState = true;
    setRelay(RELAY_FAN, true);
    if(Firebase.ready()) Firebase.RTDB.setBool(&fbdo, "/device/state/fanState", true);
  }
  sendCORS();
  server.send(200, "text/plain", "OK");
}

void setup() {
  Serial.begin(115200);

  // Initialize Pins
  // Write HIGH (relay OFF) BEFORE setting as OUTPUT to prevent boot glitch
  digitalWrite(RELAY_FAN, HIGH);
  digitalWrite(RELAY_OUTSIDE_LIGHT, HIGH);
  digitalWrite(RELAY_INSIDE_LIGHT, HIGH);
  pinMode(RELAY_FAN, OUTPUT);
  pinMode(RELAY_OUTSIDE_LIGHT, OUTPUT);
  pinMode(RELAY_INSIDE_LIGHT, OUTPUT);
  pinMode(PIR_PIN, INPUT);
  
  // Now set to actual desired state (all false/OFF at boot)
  setRelay(RELAY_FAN, fanState);
  setRelay(RELAY_OUTSIDE_LIGHT, outsideLightState);
  setRelay(RELAY_INSIDE_LIGHT, insideLightState);

  dht.begin();

  
  // Setup WiFi
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASS);
  
  
  // Add multiple WiFi networks (ESP32 will connect to the strongest available)
  wifiMulti.addAP("vivo 1811", "12344321");
  wifiMulti.addAP("OPPO Reno6 5G", "12344321");
  wifiMulti.addAP("Mansur", "Mansur1@");

  
  Serial.print("Connecting to WiFi");
  int retries = 0;
  while (wifiMulti.run() != WL_CONNECTED && retries < 20) {

    delay(500);
    Serial.print(".");
    retries++;
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? "Connected!" : "Failed, running AP");

  // Setup Firebase
  
    config.database_url = FIREBASE_DATABASE_URL;
    config.signer.tokens.legacy_token = "Syrzd2rcUYpgDCpJdG6uaN3J3PMzMhasUwz11roq";
    
    // Set buffer sizes to prevent mbedTLS OOM on ESP32
    fbdo.setBSSLBufferSize(2048, 1024);
    streamFbdo.setBSSLBufferSize(2048, 1024);
    fbdo.setResponseSize(2048);
    streamFbdo.setResponseSize(2048);
    fbdoTask.setBSSLBufferSize(2048, 1024);
    fbdoTask.setResponseSize(2048);

  
  Firebase.begin(&config, &auth);
  // Firebase.reconnectWiFi(true); // Disabled because WiFiMulti handles reconnections
  
  timeClient.begin();
  
  // Blocking NTP Time Lock
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[NTP] Acquiring time lock");
    int ntpAttempts = 0;
    while (ntpAttempts < 30) {
      timeClient.update();
      if (timeClient.getEpochTime() > 1000000000UL) {
        Serial.println("\n[NTP] Lock acquired! Epoch: " + String(timeClient.getEpochTime()));
        break;
      }
      delay(500);
      Serial.print(".");
      ntpAttempts++;
    }
    if (timeClient.getEpochTime() < 1000000000UL) {
      Serial.println("\n[NTP] Failed to acquire time lock.");
    }
  }


  // Read Boot State & Settings
  if (Firebase.ready()) {
    Firebase.RTDB.getBool(&fbdo, "/device/state/fanState", &fanState);
    Firebase.RTDB.getBool(&fbdo, "/device/state/insideLightState", &insideLightState);
    
    
    // Read Settings
    Firebase.RTDB.getFloat(&fbdo, "/Settings/voltageOffset", &voltageOffset);
    int pirMins = 5;
    if(Firebase.RTDB.getInt(&fbdo, "/Settings/pirDurationMins", &pirMins)) {
      pirHoldMs = pirMins * 60000UL;
    }
    
    // Read Energy State to survive reboots
    Firebase.RTDB.getFloat(&fbdo, "/Sensor_Data/Energy_Today_Wh", &dailyEnergy_Wh);
    int savedDayId = 0;
    if (Firebase.RTDB.getInt(&fbdo, "/Sensor_Data/Current_Day_Id", &savedDayId)) {
      currentDayId = savedDayId;
    }

    int health = 85;
    if(Firebase.RTDB.getInt(&fbdo, "/Settings/batteryHealth", &health)) {
      batteryHealth = health / 100.0f;
    }

    setRelay(RELAY_FAN, fanState);
    setRelay(RELAY_INSIDE_LIGHT, insideLightState);
  }

  // Start Firebase Stream on Core 1 (Listen for UI changes)
  if (!Firebase.RTDB.beginMultiPathStream(&streamFbdo, "/device/state,/Settings,/fanEmergency,/outsideLightForce,/outsideLightAuto")) {
    Serial.println("Stream Begin Failed");
  }
  Firebase.RTDB.setMultiPathStreamCallback(&streamFbdo, streamCallback, streamTimeoutCallback);

  // Start FreeRTOS Task on Core 0 (Network & Sensors)
  xTaskCreatePinnedToCore(
    TaskSensorsAndFirebase, 
    "SensorTask", 
    16384, 
    NULL, 
    1, 
    &TaskSensorHandle, 
    0);

  // Setup Web Server Routes
  server.on("/", handleRoot);
  server.on("/api/status", handleApiStatus);
  server.on("/api/toggle_fan", handleToggleFan);
  server.on("/api/toggle_inLight", handleToggleInLight);
  server.on("/api/toggle_outLight", handleToggleOutLight);
  server.on("/api/toggle_emerg", handleFanEmerg);
  server.begin();
  Serial.println("[WEB] HTTP Server started on port 80");
}

// =============================================================================
//  LOOP (Core 1)
// =============================================================================
void loop() {
  server.handleClient();
  uint32_t now = millis();

  // =========================================
  // HARDWARE CONFIRMATION PROCESSING (HIGHEST PRIORITY - user is waiting!)
  // =========================================
  // Process fan confirmation
  if (confirmFan.pending) {
    confirmFan.pending = false;
    if (Firebase.ready()) {
      FirebaseJson cJson;
      cJson.set("device", "fan");
      cJson.set("state", confirmFan.state);
      cJson.set("success", confirmFan.success);
      if (confirmFan.reason[0] != '\0') cJson.set("reason", confirmFan.reason);
      cJson.set("ts", (int)(millis() / 1000));
      
      Firebase.RTDB.setJSON(&fbdo, "/device/confirmed", &cJson);
      Serial.printf("[HW_CONFIRM] Fan: %s (%s)\n", confirmFan.success ? "OK" : "REJECTED", confirmFan.reason);
      
      if (!confirmFan.success) {
        skipNextFanState = true;
        Firebase.RTDB.setBool(&fbdo, "/device/state/fanState", confirmFan.state);
      }
    }
  }
  
  // Process inside light confirmation
  if (confirmLight1.pending) {
    confirmLight1.pending = false;
    if (Firebase.ready()) {
      FirebaseJson cJson;
      cJson.set("device", "light1");
      cJson.set("state", confirmLight1.state);
      cJson.set("success", confirmLight1.success);
      if (confirmLight1.reason[0] != '\0') cJson.set("reason", confirmLight1.reason);
      cJson.set("ts", (int)(millis() / 1000));
      
      Firebase.RTDB.setJSON(&fbdo, "/device/confirmed", &cJson);
      Serial.printf("[HW_CONFIRM] Light1: %s (%s)\n", confirmLight1.success ? "OK" : "REJECTED", confirmLight1.reason);
      
      if (!confirmLight1.success) {
        skipNextLight1State = true;
        Firebase.RTDB.setBool(&fbdo, "/device/state/insideLightState", confirmLight1.state);
      }
    }
  }
  
  // Process outside light confirmation
  if (confirmLight2.pending) {
    confirmLight2.pending = false;
    if (Firebase.ready()) {
      FirebaseJson cJson;
      cJson.set("device", "light2");
      cJson.set("state", confirmLight2.state);
      cJson.set("success", confirmLight2.success);
      if (confirmLight2.reason[0] != '\0') cJson.set("reason", confirmLight2.reason);
      cJson.set("ts", (int)(millis() / 1000));
      
      Firebase.RTDB.setJSON(&fbdo, "/device/confirmed", &cJson);
      Serial.printf("[HW_CONFIRM] Light2: %s (%s)\n", confirmLight2.success ? "OK" : "REJECTED", confirmLight2.reason);
      
      if (!confirmLight2.success) {
        skipNextLight2State = true;
        Firebase.RTDB.setBool(&fbdo, "/device/state/outsideLightState", confirmLight2.state);
      }
    }
  }

  // Process stream callback flags (lower priority - background cleanup)
  if (flagResetOutsideLightForce) {
    flagResetOutsideLightForce = false;
    if (Firebase.ready()) Firebase.RTDB.setBool(&fbdo, "/outsideLightForce", false);
  }
  if (flagResetOutsideLightAuto) {
    flagResetOutsideLightAuto = false;
    if (Firebase.ready()) Firebase.RTDB.setBool(&fbdo, "/outsideLightAuto", false);
  }
  if (flagResetFanEmergency) {
    flagResetFanEmergency = false;
    if (Firebase.ready()) Firebase.RTDB.setBool(&fbdo, "/fanEmergency", false);
  }

  // Auto-reconnect WiFi using WiFiMulti if connection drops
  if (WiFi.status() != WL_CONNECTED) {
    static uint32_t lastWifiRetryMs = 0;
    if (now - lastWifiRetryMs >= 5000UL) {
      lastWifiRetryMs = now;
      Serial.println("[WIFI] Connection lost. Scanning for known networks...");
      wifiMulti.run();
    }
  }

  
  
  // Fan Emergency Timeout Logic
  if (fanEmergencyActive) {
    if (now - fanEmergencyStartMs >= FAN_EMERGENCY_DURATION_MS) {
      fanEmergencyActive = false;
      fanState = false; // Auto turn off after 10 mins
      setRelay(RELAY_FAN, false);
      if (Firebase.ready()) {
        flagResetFanEmergency = true;
        Firebase.RTDB.setBool(&fbdo, "/device/state/fanState", false);
      }
      Serial.println("[FAN] Emergency 10-min timeout reached. Fan OFF.");
    }
  }

  
  timeClient.update();
  int currentHour = timeClient.getHours();
  bool isNightTime = (currentHour >= 18 || currentHour < 6);

  // Handle Force Mode 1-hour Timeout
  if (outsideForceMode != 0) {
    if (now - outsideForceStartMs >= currentForceDurationMs) {
      outsideForceMode = 0;
      Serial.println("[LIGHT] Force mode 1-hour timeout reached. Returning to Auto.");
    }
  }

  // Apply Force Mode State (only write once when state changes)
  static bool forceStateApplied = false;
  if (outsideForceMode == 1 && !outsideLightState && !forceStateApplied) {
      forceStateApplied = true;
      outsideLightState = true;
      setRelay(RELAY_OUTSIDE_LIGHT, true);
      if (Firebase.ready()) Firebase.RTDB.setBool(&fbdo, "/device/state/outsideLightState", true);
  } else if (outsideForceMode == 2 && outsideLightState && !forceStateApplied) {
      forceStateApplied = true;
      outsideLightState = false;
      setRelay(RELAY_OUTSIDE_LIGHT, false);
      if (Firebase.ready()) Firebase.RTDB.setBool(&fbdo, "/device/state/outsideLightState", false);
  } else if (outsideForceMode == 0) {
      forceStateApplied = false;
  }

  // PIR Logic for Outside Light (Only in Auto Mode)
  if (digitalRead(PIR_PIN) == HIGH) {
    pirMotionDetected = true;
    pirLastMotionMs = now;
    
    // Only turn on if Auto mode AND it is night time
    if (outsideForceMode == 0 && isNightTime && !outsideLightState) {
      outsideLightState = true;
      setRelay(RELAY_OUTSIDE_LIGHT, true);
      if (Firebase.ready()) Firebase.RTDB.setBool(&fbdo, "/device/state/outsideLightState", true);
      Serial.println("[PIR] Night Motion Detected - Light ON");
    }
  }

  // PIR Timeout Auto-OFF (Only in Auto Mode)
  if (outsideForceMode == 0 && outsideLightState) {
    if (now - pirLastMotionMs >= pirHoldMs) {
      outsideLightState = false;
      setRelay(RELAY_OUTSIDE_LIGHT, false);
      if (Firebase.ready()) Firebase.RTDB.setBool(&fbdo, "/device/state/outsideLightState", false);
      Serial.println("[PIR] Timeout - Light OFF");
    }
  }


  delay(50); // Small delay to yield Core 1
}

























