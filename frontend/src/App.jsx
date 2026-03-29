import CollabEditorYjs from "./CollabEditorYjs";

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('name') || 'Anonymous';
  const room = params.get('room') || 'default';

  const wsUrl =
    window.location.hostname === "localhost"
      ? "ws://localhost:3001"                    
      : "wss://codesync-1zeu.onrender.com/";        

  return (
    <CollabEditorYjs
      wsUrl={wsUrl}
      roomId={room}
      userName={name}
      userColor="#8B5CF6"
    />
  );
}