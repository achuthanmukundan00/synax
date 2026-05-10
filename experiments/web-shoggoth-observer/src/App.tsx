import React from "react";
import ModelObserverPage from "./ModelObserverPage";
import { useSSEConnection } from "./useSSEConnection";

/**
 * Root App component.
 * Initializes SSE connection and renders the observer page.
 */
const App: React.FC = () => {
  useSSEConnection();

  return <ModelObserverPage />;
};

export default App;
