import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import Overview from "./pages/Overview";
import RideApp from "./pages/RideApp";
import ChaosLab from "./pages/ChaosLab";
import SecurityLab from "./pages/SecurityLab";
import Observability from "./pages/Observability";
import Reports from "./pages/Reports";
import Architecture from "./pages/Architecture";
import "./styles.css";

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ margin: 40 }}>
          <h3>Something went wrong on this page</h3>
          <p className="muted">{String(this.state.error.message || this.state.error)}</p>
          <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// keyed on the path so an error on one page doesn't stick after navigating away
function Pages() {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/rides" element={<RideApp />} />
        <Route path="/chaos" element={<ChaosLab />} />
        <Route path="/security" element={<SecurityLab />} />
        <Route path="/observability" element={<Observability />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/architecture" element={<Architecture />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Layout>
        <Pages />
      </Layout>
    </BrowserRouter>
  </React.StrictMode>,
);
