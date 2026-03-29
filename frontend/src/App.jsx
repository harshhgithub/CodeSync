import CollabEditorYjs from "./CollabEditorYjs";

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('name') || 'Anonymous';
  const room = params.get('room') || 'default';

  return (
    <CollabEditorYjs
      wsUrl="ws://localhost:3001"
      roomId={room}
      userName={name}
      userColor="#8B5CF6"
    />
  );
}
