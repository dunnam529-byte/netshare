# RegnisPortal: Secure Local Transfer & Chat Network

RegnisPortal is an immersive, next-generation, cyberpunk-inspired local file sharing and group chat network. It is powered by a Google Chrome Extension Admin UI (Manifest V3) and a companion Node.js local network server.

Anyone on the same local network (Wi-Fi or LAN) can securely connect to your machine’s IP address or local domain, join the network with a secure nickname, initiate group chat broadcasts, share files smoothly with direct progress bars, or send private/direct files to specific peers.

All network controls are held by the main computer which runs the Chrome Extension with a fully featured real-time Admin UI to monitor nodes, view live telemetry logs, toggle features (group chat/file sharing), and block/unblock unwanted network IPs.

---

## Architecture Overview

1. **Companion Local Server (`server/`)**:
   - A Node.js HTTP & WebSocket server (`server.js`) that handles incoming static files, file uploads, file downloads, active websocket sessions, and real-time event broadcasting.
   - Automatic local IP interface detection so you know exactly which URLs to share on your LAN.
   - Robust IP-based blocklists and real-time configuration toggles (e.g. disabling file sharing or group chat on the fly).

2. **Gorgeous Client Webpage (`server/public/`)**:
   - Immersive, mobile-first responsive design featuring an abstract holographic background grid with neon auroras.
   - Real-time chat (Subnet Broadcast and direct private messaging channels).
   - Dynamic user-list of other active nodes on the subnet.
   - Robust file transfer engine with interactive live upload percentage progress bars.

3. **Chrome Extension Host UI (`extension/`)**:
   - **Extension Action Popup (`popup.html` / `popup.js`)**: Real-time wellness check of the companion server, listing of active LAN IPs, customizable server host URL (for custom domains like `http://lanconnect.local:8080`), and direct launch trigger for the Admin console.
   - **Admin Panel Dashboard (`admin.html` / `admin.js` / `admin.css`)**: Immersive management terminal displaying key metrics (active nodes, channels, blocked IPs), live event telemetry streams, toggles for group chat and file sharing arrays, table of active client nodes, and manual or click-based IP blocking controls.

---

## Getting Started

### 1. Prerequisites
Make sure you have [Node.js](https://nodejs.org/) (version 16 or later) installed on the host computer.

### 2. Running the Local Server
Navigate to the server directory and run:
```bash
cd server
npm install
npm start
```
By default, the server will start listening on port `8080`. The console will log the local URLs and active LAN IPs available for your subnet:
```text
[SERVER RUNNING]
Local address: http://localhost:8080
Network URLs:
  http://192.168.1.100:8080
```

### 3. Running the Tests
To run the automated suite testing routing, download arrays, and block logic, run:
```bash
cd server
npm test
```

### 4. Installing the Chrome Extension
1. Open Google Chrome.
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select the `extension` directory of this project.

Once loaded, the Regnis Shield icon will appear in your Chrome toolbar!

---

## Using Local Domains & IP Addresses

### 1. Connecting via Local IP (Default)
Other users on the same Wi-Fi or local area network can simply type the host PC's LAN IP address in their browser (e.g. `http://192.168.1.100:8080`). This address is clearly displayed inside the **Extension Popup** and **Admin Tab**.

### 2. Connecting via a Local Domain (e.g., `lanconnect.local`)
If you want users to connect using a user-friendly domain name (e.g., `http://lanconnect.local:8080`) instead of typing raw IP addresses:
1. On the client computer(s) or host, open your operating system's `hosts` file:
   - **Windows**: `C:\Windows\System32\drivers\etc\hosts` (open as Administrator)
   - **macOS / Linux**: `/etc/hosts` (edit using `sudo nano /etc/hosts`)
2. Append a mapping between the host PC's LAN IP and your local domain name:
   ```text
   192.168.1.100 lanconnect.local
   ```
3. Now, anyone can access the chat and file array simply by visiting `http://lanconnect.local:8080`!
4. You can configure this domain directly in the **Extension Action Popup**'s *Server Config Url* input and click **SAVE**. The Admin Dashboard will instantly redirect its management WebSocket to connect through the local domain!

---

## Features Showcase

* **IP Blocking Controls**: When you block an IP, the server immediately severs their WebSocket connection, redirects them to a "CONNECTION SEVERED" screen, and denies any subsequent HTTP file downloads or uploads.
* **Direct Sharing**: Simply click on an active node under *Subnet Nodes* to start a secure private channel. Any files attached or messages sent will only be visible to you and that selected recipient node.
* **Immersive Visuals**: Designed with Space Grotesk, Plus Jakarta Sans, and Inter typography, custom neon borders, glowing shadow indicators, glassmorphic card overlays, and high-fidelity gradients.
