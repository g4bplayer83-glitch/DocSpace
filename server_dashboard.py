import json
import threading
import time
import tkinter as tk
from tkinter import ttk, messagebox
from urllib import request, error

REFRESH_SECONDS = 3


def fetch_json(url: str, timeout: float = 3.0):
    req = request.Request(url, headers={"User-Agent": "DocSpaceDashboard/1.0"})
    with request.urlopen(req, timeout=timeout) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status}")
        return json.loads(resp.read().decode("utf-8"))


class DashboardApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("DocSpace Server Dashboard")
        self.geometry("980x640")
        self.minsize(860, 560)

        self.running = False
        self.worker = None
        self.latest = None

        self.base_url = tk.StringVar(value="http://localhost:3000")
        self.status_text = tk.StringVar(value="Prêt")

        self._build_ui()

    def _build_ui(self):
        top = ttk.Frame(self, padding=10)
        top.pack(fill="x")

        ttk.Label(top, text="URL serveur:").pack(side="left")
        entry = ttk.Entry(top, textvariable=self.base_url, width=36)
        entry.pack(side="left", padx=(8, 8))

        ttk.Button(top, text="Tester", command=self.manual_refresh).pack(side="left")
        self.toggle_btn = ttk.Button(top, text="Démarrer auto-refresh", command=self.toggle_refresh)
        self.toggle_btn.pack(side="left", padx=(8, 0))

        ttk.Label(top, textvariable=self.status_text).pack(side="right")

        self.notebook = ttk.Notebook(self)
        self.notebook.pack(fill="both", expand=True, padx=10, pady=(0, 10))

        self.tab_overview = ttk.Frame(self.notebook, padding=12)
        self.tab_channels = ttk.Frame(self.notebook, padding=12)
        self.tab_voice = ttk.Frame(self.notebook, padding=12)
        self.tab_realtime = ttk.Frame(self.notebook, padding=12)

        self.notebook.add(self.tab_overview, text="Vue globale")
        self.notebook.add(self.tab_channels, text="Salons textuels")
        self.notebook.add(self.tab_voice, text="Salons vocaux")
        self.notebook.add(self.tab_realtime, text="Temps réel")

        self._build_overview_tab()
        self._build_channels_tab()
        self._build_voice_tab()
        self._build_realtime_tab()

    def _build_overview_tab(self):
        self.lbl_server = ttk.Label(self.tab_overview, text="Serveur: -", font=("Segoe UI", 12, "bold"))
        self.lbl_server.pack(anchor="w", pady=(0, 8))

        grid = ttk.Frame(self.tab_overview)
        grid.pack(fill="x", pady=6)

        self.lbl_online = ttk.Label(grid, text="En ligne: -")
        self.lbl_messages = ttk.Label(grid, text="Messages: -")
        self.lbl_uploads = ttk.Label(grid, text="Uploads: -")
        self.lbl_connections = ttk.Label(grid, text="Connexions: -")
        self.lbl_uptime = ttk.Label(grid, text="Uptime: -")
        self.lbl_memory = ttk.Label(grid, text="Mémoire: -")

        labels = [
            self.lbl_online,
            self.lbl_messages,
            self.lbl_uploads,
            self.lbl_connections,
            self.lbl_uptime,
            self.lbl_memory,
        ]

        for i, lbl in enumerate(labels):
            lbl.grid(row=i // 2, column=i % 2, sticky="w", padx=10, pady=6)

        self.lbl_updated = ttk.Label(self.tab_overview, text="Dernière MAJ: -")
        self.lbl_updated.pack(anchor="w", pady=(12, 0))

    def _build_channels_tab(self):
        cols = ("name", "messages")
        self.tree_channels = ttk.Treeview(self.tab_channels, columns=cols, show="headings", height=18)
        self.tree_channels.heading("name", text="Salon")
        self.tree_channels.heading("messages", text="Messages")
        self.tree_channels.column("name", width=380)
        self.tree_channels.column("messages", width=140, anchor="e")
        self.tree_channels.pack(fill="both", expand=True)

    def _build_voice_tab(self):
        cols = ("name", "participants")
        self.tree_voice = ttk.Treeview(self.tab_voice, columns=cols, show="headings", height=18)
        self.tree_voice.heading("name", text="Salon vocal")
        self.tree_voice.heading("participants", text="Participants")
        self.tree_voice.column("name", width=380)
        self.tree_voice.column("participants", width=140, anchor="e")
        self.tree_voice.pack(fill="both", expand=True)

    def _build_realtime_tab(self):
        self.lbl_games = ttk.Label(self.tab_realtime, text="Parties actives: -")
        self.lbl_invites = ttk.Label(self.tab_realtime, text="Invitations en attente: -")
        self.lbl_typing = ttk.Label(self.tab_realtime, text="Utilisateurs en train d'écrire: -")
        self.lbl_generated = ttk.Label(self.tab_realtime, text="Généré à: -")

        self.lbl_games.pack(anchor="w", pady=6)
        self.lbl_invites.pack(anchor="w", pady=6)
        self.lbl_typing.pack(anchor="w", pady=6)
        self.lbl_generated.pack(anchor="w", pady=6)

    def manual_refresh(self):
        try:
            base = self.base_url.get().rstrip("/")
            data = fetch_json(f"{base}/api/server/dashboard")
            self.apply_data(data)
            self.status_text.set("Connexion OK")
        except Exception as exc:
            self.status_text.set("Erreur de connexion")
            messagebox.showerror("Erreur", f"Impossible de charger les données:\n{exc}")

    def toggle_refresh(self):
        self.running = not self.running
        if self.running:
            self.toggle_btn.config(text="Arrêter auto-refresh")
            self.status_text.set("Auto-refresh actif")
            self.worker = threading.Thread(target=self._loop, daemon=True)
            self.worker.start()
        else:
            self.toggle_btn.config(text="Démarrer auto-refresh")
            self.status_text.set("Auto-refresh arrêté")

    def _loop(self):
        while self.running:
            base = self.base_url.get().rstrip("/")
            try:
                data = fetch_json(f"{base}/api/server/dashboard")
                self.after(0, lambda d=data: self.apply_data(d))
                self.after(0, lambda: self.status_text.set("Auto-refresh actif"))
            except Exception as exc:
                self.after(0, lambda e=exc: self.status_text.set(f"Erreur: {e}"))
            time.sleep(REFRESH_SECONDS)

    def apply_data(self, data: dict):
        self.latest = data

        server = data.get("server", {})
        traffic = data.get("traffic", {})
        memory = data.get("memory", {})
        channels = data.get("channels", {})
        realtime = data.get("realtime", {})

        self.lbl_server.config(
            text=f"Serveur: {server.get('name', '-')} v{server.get('version', '-')} | Node {server.get('node', '-')}"
        )
        self.lbl_online.config(text=f"En ligne: {traffic.get('onlineUsers', 0)}")
        self.lbl_messages.config(text=f"Messages: {traffic.get('totalMessages', 0)}")
        self.lbl_uploads.config(text=f"Uploads: {traffic.get('totalUploads', 0)}")
        self.lbl_connections.config(text=f"Connexions: {traffic.get('totalConnections', 0)}")

        uptime_s = int(server.get("uptimeSeconds", 0) or 0)
        uptime_h = uptime_s // 3600
        uptime_m = (uptime_s % 3600) // 60
        uptime_sec = uptime_s % 60
        self.lbl_uptime.config(text=f"Uptime: {uptime_h}h {uptime_m}m {uptime_sec}s")
        self.lbl_memory.config(
            text=(
                f"Mémoire: heap {memory.get('heapUsedMB', 0)} / {memory.get('heapTotalMB', 0)} MB"
                f" | rss {memory.get('rssMB', 0)} MB"
            )
        )

        self.lbl_updated.config(text=f"Dernière MAJ: {data.get('generatedAt', '-')}")

        for row in self.tree_channels.get_children():
            self.tree_channels.delete(row)
        for row in channels.get("topTextByMessages", []):
            self.tree_channels.insert("", "end", values=(row.get("name", "-"), row.get("messages", 0)))

        for row in self.tree_voice.get_children():
            self.tree_voice.delete(row)
        for row in channels.get("voiceRooms", []):
            self.tree_voice.insert("", "end", values=(row.get("name", "-"), row.get("participants", 0)))

        self.lbl_games.config(text=f"Parties actives: {realtime.get('activeGames', 0)}")
        self.lbl_invites.config(text=f"Invitations en attente: {realtime.get('pendingInvites', 0)}")
        self.lbl_typing.config(text=f"Utilisateurs en train d'écrire: {realtime.get('typingUsers', 0)}")
        self.lbl_generated.config(text=f"Généré à: {data.get('generatedAt', '-')}")


if __name__ == "__main__":
    app = DashboardApp()
    app.mainloop()
