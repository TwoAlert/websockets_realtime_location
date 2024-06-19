require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: process.env.DATABASE_URL,
});

const db = admin.database();
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Endpoint HTTP para verificação
app.get('/', (req, res) => {
  res.send('Servidor WebSocket está funcionando');
});

server.on('upgrade', (request, socket, head) => {
  console.log('Received upgrade request');
  console.log('Upgrade request headers:', request.headers);

  wss.handleUpgrade(request, socket, head, (ws) => {
    console.log('Upgrade successful');
    wss.emit('connection', ws, request);
  });

  socket.on('error', (error) => {
    console.log('Socket error during upgrade:', error);
  });
});

wss.on('connection', (ws, request) => {
  console.log('New client connected');
  console.log('Connection request headers:', request.headers);

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async (message) => {
    console.log('Received message:', message.toString());
    const data = JSON.parse(message);

    let sessionRef;

    switch (data.type) {
      case 'adminJoin':
        const trackerId = `location_${Math.random().toString(36).substr(2, 8)}`;
        const adminRef = db.ref(`sessions/${trackerId}`);
        adminRef.set({
          admin: {
            uid: data.uid,
            deviceId: data.deviceId,
            name: data.name,
            photo: data.photo,
            isAlive: true
          },
          location: {
            latitude: data.location.latitude,
            longitude: data.location.longitude,
            timestamp: data.timestampLocal,
            alarmStatus: data.alarmStatus,
          },
          duration: data.duration,
          viewers: data.viewers,
          sendTimestamp: data.sendTimestamp,
          timestampServer: data.timestampServer,
          allowNewViewers: true
        });
        ws.trackerId = trackerId;
        ws.uid = data.uid;
        ws.deviceId = data.deviceId,
          ws.send(JSON.stringify({ type: 'adminJoined', status: 'allowed', trackerId, message: 'Admin joined successfully' }));
        break;
      case 'adminReconnect':
        console.log('Admin reconnecting:', data);
        sessionRef = db.ref(`sessions/${data.trackerId}`);
        const sessionReconnectSnapshot = await sessionRef.once('value');

        if (sessionReconnectSnapshot.exists()) {
          sessionRef.child('admin').update({
            isAlive: true
          });
          ws.trackerId = data.trackerId;
          ws.uid = data.uid;
          ws.deviceId = data.deviceId;
          ws.send(JSON.stringify({ type: 'adminReconnected', status: 'allowed', trackerId: data.trackerId, message: 'Admin reconnected successfully' }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
        }
        break;
      case 'viewerJoin':
        sessionRef = db.ref(`sessions/${data.trackerId}`);
        const sessionSnapshot = await sessionRef.once('value');
        if (!sessionSnapshot.exists()) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          ws.close();
        } else if (sessionSnapshot.child('viewers').numChildren() >= 3) {
          ws.send(JSON.stringify({ type: 'error', message: 'Limite de visualizadores atingido' }));
          ws.close();
        } else if (sessionSnapshot.child('blocked').child(data.uid).exists()) {
          ws.send(JSON.stringify({ type: 'error', message: 'Você foi bloqueado pelo administrador e não pode ver esta localização' }));
          ws.close();
        } else if (!sessionSnapshot.child('allowNewViewers').val()) {
          ws.send(JSON.stringify({ type: 'error', message: 'New viewers are not allowed' }));
          ws.close();
        } else {
          const viewerRef = sessionRef.child(`viewers/${data.uid}`);
          viewerRef.set({ uid: data.uid, deviceId: data.deviceId, isAlive: true });
          ws.trackerId = data.trackerId;
          ws.uid = data.uid;
          ws.deviceId = data.deviceId;

          const location = sessionSnapshot.child('location').val();
          const adminPhoto = sessionSnapshot.child('admin/photo').val();
          const adminName = sessionSnapshot.child('admin/name').val();

          ws.send(JSON.stringify({
            type: 'viewerJoined',
            status: 'allowed',
            message: 'Viewer joined successfully',
            location: location,
            adminPhoto: adminPhoto,
            adminName: adminName
          }));
        }
        break;
      case 'blockUser':
        console.log('Blocking user:', data);
        sessionRef = db.ref(`sessions/${data.trackerId}`);
        const viewersRef = sessionRef.child('viewers');
        const blockedRef = sessionRef.child('blocked');

        // Remover usuário da lista de visualizadores
        await viewersRef.child(data.userToBlock).remove();

        // Adicionar usuário à lista de bloqueados
        await blockedRef.child(data.userToBlock).set(true);

        // Enviar mensagem de desconexão para o usuário bloqueado
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.uid === data.userToBlock) {
            client.send(JSON.stringify({ type: 'disconnected', message: 'Você foi bloqueado pelo administrador e não pode ver esta localização' }));
            client.close();
          }
        });

        ws.send(JSON.stringify({ type: 'userBlocked', status: 'allowed', userToBlock: data.userToBlock, message: 'User blocked successfully' }));
        break;
      case 'unblockUser':
        console.log('Unblocking user:', data);
        sessionRef = db.ref(`sessions/${data.trackerId}`);
        const blockedReference = sessionRef.child('blocked');

        // Remover usuário da lista de bloqueados
        await blockedReference.child(data.userToUnblock).remove();

        ws.send(JSON.stringify({ type: 'userUnblocked', status: 'allowed', userToUnblock: data.userToUnblock, message: 'User unblocked successfully' }));
        break;

      case 'locationUpdate':
        sessionRef = db.ref(`sessions/${ws.trackerId}`);
        if (ws.trackerId) {
          const locationRef = sessionRef.child('location');
          locationRef.update({
            latitude: data.location.latitude,
            longitude: data.location.longitude,
            timestamp: data.timestamp,
          });
          sessionRef.child('viewers').once('value', (snapshot) => {
            snapshot.forEach(viewer => {
              if (viewer.key !== ws.uid) {
                viewer.ref.child('updates').push({
                  type: 'locationUpdate',
                  latitude: data.location.latitude,
                  longitude: data.location.longitude,
                  timestamp: data.timestamp,
                });
              }
            });
          });
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Somente o admin pode enviar atualizações de localização' }));
        }
        break;
      case 'toggleNewViewers':
        console.log('Toggling new viewers:', data);
        sessionRef = db.ref(`sessions/${data.trackerId}`);
        const allowNewViewersRef = sessionRef.child('allowNewViewers');

        // Alternar o valor de allowNewViewers
        allowNewViewersRef.once('value', (snapshot) => {
          const currentValue = snapshot.val();
          allowNewViewersRef.set(!currentValue);
        });

        ws.send(JSON.stringify({ type: 'newViewersToggled', status: 'allowed', message: 'New viewers access toggled successfully' }));
        break;
      case 'alarmUpdate':
        sessionRef = db.ref(`sessions/${ws.trackerId}`);
        if (ws.trackerId) {
          const alarmRef = sessionRef.child('location/alarmStatus');
          alarmRef.set(data.alarmStatus);
          sessionRef.child('viewers').once('value', (snapshot) => {
            snapshot.forEach(viewer => {
              if (viewer.key !== ws.uid) {
                viewer.ref.child('updates').push({
                  type: 'alarmUpdate',
                  alarmStatus: data.alarmStatus
                });
              }
            });
          });
          // Notificar todos os viewers
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.trackerId === ws.trackerId) {
              client.send(JSON.stringify({ type: 'alarmUpdate', alarmStatus: data.alarmStatus }));
            }
          });
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Somente o admin pode atualizar o status do alarme' }));
        }
        break;

      case 'stop':
        sessionRef = db.ref(`sessions/${data.trackerId}`);
        if (sessionRef) {
          await sessionRef.remove();
          console.log(`Sessão ${data.trackerId} removida`);
          ws.send(JSON.stringify({ type: 'stopped', message: 'Compartilhamento de localização parado com sucesso' }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Sessão não encontrada' }));
        }
        break;

      case 'viewerLeave':
        sessionRef = db.ref(`sessions/${ws.trackerId}`);
        if (ws.trackerId) {
          const viewerRef = sessionRef.child('viewers').orderByChild('deviceId').equalTo(data.deviceId);
          const viewerSnapshot = await viewerRef.once('value');
          viewerSnapshot.forEach((childSnapshot) => {
            childSnapshot.ref.remove();
          });
          ws.send(JSON.stringify({ type: 'viewerLeft', message: 'Viewer left successfully' }));
        }
        break;

      case 'ping':
        console.log('Ping received');
        ws.isAlive = true;
        break;

      default:
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
        break;
    }
  });

  ws.on('close', async () => {
    console.log('Client disconnected');
    if (ws.trackerId) {
      const sessionRef = db.ref(`sessions/${ws.trackerId}`);
      const sessionSnapshot = await sessionRef.once('value');
      const adminUid = sessionSnapshot.child('admin/uid').val();
      const adminDeviceId = sessionSnapshot.child('admin/deviceId').val();

      if (ws.uid === adminUid && ws.deviceId === adminDeviceId) {
        console.log('Admin is disconnecting. Removing session:', ws.trackerId);
        await sessionRef.remove();
      } else {
        console.log('Viewer is disconnecting. Removing viewer from session:', ws.trackerId);
        const viewerRef = sessionRef.child('viewers').orderByChild('deviceId').equalTo(ws.deviceId);
        const viewerSnapshot = await viewerRef.once('value');
        viewerSnapshot.forEach((childSnapshot) => {
          childSnapshot.ref.remove();
        });
      }
    }
  });


  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});


const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log('Client connection lost, terminating...');
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  console.log('WebSocket server started');
});


