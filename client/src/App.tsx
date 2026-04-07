import { useState } from "react";
import { LayoutDashboard, MessageSquare, Users, Settings, Zap } from "lucide-react";
import Dashboard from "./components/Dashboard";
import Chat from "./components/Chat";
import StaffingView from "./components/StaffingView";
import SettingsPanel from "./components/SettingsPanel";

const tabs = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "chat", label: "AI Analyst", icon: MessageSquare },
  { id: "staffing", label: "Staffing", icon: Users },
  { id: "settings", label: "Settings", icon: Settings },
] as const;

type TabId = (typeof tabs)[number]["id"];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-navy-800 text-white px-6 py-3 flex items-center justify-between shadow-lg">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center">
            <Zap size={18} strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight leading-none">
              Financial Impact Analyzer
            </h1>
            <p className="text-[10px] text-steel-200 tracking-widest uppercase mt-0.5">
              Local + Cloud AI · Portable Edition
            </p>
          </div>
        </div>
      </header>

      {/* Tab bar */}
      <nav className="bg-white border-b border-steel-100 px-6">
        <div className="flex gap-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  isActive
                    ? "border-navy-700 text-navy-800"
                    : "border-transparent text-steel-500 hover:text-navy-700 hover:border-steel-200"
                }`}
              >
                <Icon size={16} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Content */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {activeTab === "dashboard" && <Dashboard />}
        {activeTab === "chat" && <Chat />}
        {activeTab === "staffing" && <StaffingView />}
        {activeTab === "settings" && <SettingsPanel />}
      </main>

      {/* Footer */}
      <footer className="px-6 py-2 text-center text-[10px] text-steel-500 border-t border-steel-100 bg-white">
        Data stored locally in SQLite · PAT transmitted only to models.github.ai via HTTPS
      </footer>
    </div>
  );
}
