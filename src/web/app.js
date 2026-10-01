/* AInterceptor Harness UI. Plain ES module-free JS, no build step. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) {
          var msg = (body && body.error) || ("HTTP " + r.status);
          throw new Error(msg);
        }
        return body;
      });
    });
  }

  /* ---- tabs ---- */
  var tabs = document.querySelectorAll("nav button");
  Array.prototype.forEach.call(tabs, function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call(tabs, function (x) { x.classList.remove("on"); });
      b.classList.add("on");
      ["diag", "hosts", "ws", "chat", "events"].forEach(function (t) {
        $("tab-" + t).classList.toggle("on", t === b.getAttribute("data-tab"));
      });
    });
  });

  /* ---- backend badge ---- */
  api("/api/config").then(function (c) {
    $("backendBadge").textContent = "AI backend: " + c.ainterceptor.baseUrl;
    $("backendBadge").title = "model alias: " + c.ainterceptor.defaultModel +
      " | key ref: " + c.ainterceptor.apiKeyRef;
  }).catch(function () { $("backendBadge").textContent = "backend: unknown"; });

  /* ---- diagnostics ---- */
  function renderDiag(d) {
    var html = '<div class="card"><div class="row"><span class="pill ' + d.overall + '">' +
      d.overall + "</span><span class=\"muted\">" + esc(d.generatedAt) + "</span></div>";
    html += '<table><thead><tr><th>Check</th><th>Verdict</th><th>Evidence</th></tr></thead><tbody>';
    d.checks.forEach(function (c) {
      html += "<tr><td>" + esc(c.name) + '</td><td><span class="pill ' + c.verdict + '">' +
        c.verdict + "</span></td><td>" + esc(c.detail) + "</td></tr>";
    });
    html += "</tbody></table></div>";

    html += '<div class="card"><div class="kv"><b>AI backend</b> ' + esc(d.aiBackend.baseUrl) +
      '<br><b>key reference</b> <code>' + esc(d.aiBackend.apiKeyRef) + "</code> (" +
      (d.aiBackend.keyPresent ? "present" : "MISSING") + ", value never exposed)" +
      "<br><b>reachable</b> " + (d.aiBackend.reachable ? "yes" : "no") +
      (d.aiBackend.activeProviders ? "<br><b>active providers</b> " + esc(d.aiBackend.activeProviders.join(", ")) : "") +
      "</div></div>";

    var rs = d.redactionStats || {};
    var keys = Object.keys(rs);
    html += '<div class="card"><div class="kv"><b>redaction stage</b> ' +
      (keys.length ? keys.map(function (k) { return esc(k) + " &times; " + rs[k]; }).join(", ")
                   : "active, nothing redacted yet") + "</div></div>";

    $("diagOut").innerHTML = html;
    $("diagWhen").textContent = "as of " + new Date().toLocaleTimeString();
  }
  function runDiag(refresh) {
    $("diagOut").innerHTML = '<p class="muted">Running…</p>';
    api("/api/diagnostics" + (refresh ? "?refresh=1" : "")).then(renderDiag)
      .catch(function (e) { $("diagOut").innerHTML = '<p class="err">' + esc(e.message) + "</p>"; });
  }
  $("runDiag").addEventListener("click", function () { runDiag(false); });
  $("runDiagFresh").addEventListener("click", function () { runDiag(true); });

  /* ---- hosts ---- */
  function renderHosts(hosts) {
    var sel = $("execTarget");
    var keep = sel.value;
    sel.innerHTML = hosts.map(function (h) {
      return '<option value="' + esc(h.id) + '">[' + esc(h.label) + "] " + esc(h.id) + "</option>";
    }).join("");
    if (keep) sel.value = keep;
    $("wsHost").innerHTML = sel.innerHTML;

    var html = "";
    hosts.forEach(function (h) {
      var v = h.reachable ? "PASS" : "FAIL";
      html += '<div class="card"><div class="row"><span class="pill ' + v + '">' + v + "</span>" +
        "<b>" + esc(h.label) + "</b> <code>" + esc(h.id) + "</code> <span class=\"muted\">" +
        esc(h.transport) + "</span></div>";
      if (!h.reachable) {
        html += '<p class="err" style="margin:8px 0 0">' + esc(h.error || "unreachable") + "</p></div>";
        return;
      }
      html += '<div class="grid2" style="margin-top:10px"><div class="kv">' +
        "<b>host</b> " + esc(h.identity.hostname || "?") + "<br>" +
        "<b>os</b> " + esc(h.identity.os || "?") + "<br>" +
        "<b>kernel</b> " + esc(h.identity.kernel || "?") + "<br>" +
        "<b>arch</b> " + esc(h.identity.arch || "?") + "</div><div class=\"kv\">" +
        "<b>cpu</b> " + esc((h.resources.cpuCores || "?") + " cores") + "<br>" +
        "<b>memory</b> " + esc(h.resources.memAvailableMb != null && h.resources.memTotalMb != null
            ? h.resources.memAvailableMb + " / " + h.resources.memTotalMb + " MB free" : "?") + "<br>" +
        "<b>disk</b> " + esc(h.resources.diskFree || "?") + "<br>" +
        "<b>tailscale</b> " + esc(h.network.tailscaleIp || "none") + "</div></div>";

      if (h.notes && h.notes.length) {
        html += '<p class="muted" style="margin:9px 0 0">notes: ' + esc(h.notes.join("; ")) + "</p>";
      }
      var present = h.capabilities.filter(function (c) { return c.present; });
      var absent = h.capabilities.filter(function (c) { return !c.present; }).map(function (c) { return c.name; });
      html += '<div style="margin-top:10px"><b class="kv">toolchain</b> <span class="muted">' +
        (present.length ? present.map(function (c) { return esc(c.name); }).join(", ") : "none") + "</span>";
      if (absent.length) {
        html += '<br><b class="kv">absent</b> <span class="muted">' + esc(absent.join(", ")) + "</span>";
      }
      html += "</div></div>";
    });
    $("hostsOut").innerHTML = html;
  }
  function loadHosts(refresh) {
    $("hostsOut").innerHTML = '<p class="muted">Probing…</p>';
    api("/api/hosts" + (refresh ? "?refresh=1" : "")).then(renderHosts)
      .catch(function (e) { $("hostsOut").innerHTML = '<p class="err">' + esc(e.message) + "</p>"; });
  }
  $("loadHosts").addEventListener("click", function () { loadHosts(false); });
  $("loadHostsFresh").addEventListener("click", function () { loadHosts(true); });

  /* ---- exec ---- */
  $("execRun").addEventListener("click", function () {
    var target = $("execTarget").value;
    var command = $("execCmd").value.trim();
    if (!command) return;
    var out = $("execOut");
    out.hidden = false;
    out.textContent = "running on " + target + " …";
    api("/api/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: target, command: command })
    }).then(function (r) {
      out.textContent = "$ [" + r.transport + ":" + r.target + "] " + command +
        "\n\nexit=" + r.exitCode + "  " + r.durationMs + "ms" +
        (r.timedOut ? "  TIMED OUT" : "") +
        "\n\n" + (r.stdout || "") + (r.stderr ? "\n[stderr]\n" + r.stderr : "");
    }).catch(function (e) { out.textContent = "error: " + e.message; });
  });

  /* ---- workspaces ---- */
  function renderTree(nodes, prefix) {
    var html = "";
    nodes.forEach(function (n) {
      if (n.type === "dir") {
        html += "<div><span class=\"d\">" + esc(prefix + n.name + "/") + "</span>" +
          (n.truncated ? ' <span class="muted">(not expanded)</span>' : "") + "</div>";
        if (n.children && n.children.length) html += renderTree(n.children, prefix + "  ");
      } else {
        html += "<div><span class=\"f\">" + esc(prefix + n.name) + "</span>" +
          (n.size != null ? ' <span class="muted">' + n.size + " B</span>" : "") + "</div>";
      }
    });
    return html;
  }

  function loadWorkspaces() {
    api("/api/workspaces").then(function (list) {
      if (!list.length) { $("wsList").innerHTML = '<p class="muted">No workspaces registered.</p>'; return; }
      $("wsList").innerHTML = '<div class="card"><table><thead><tr><th>Name</th><th>Root</th><th>Host</th><th></th></tr></thead><tbody>' +
        list.map(function (w) {
          return "<tr><td>" + esc(w.name) + "</td><td><code>" + esc(w.root) + "</code></td><td>" +
            esc(w.host) + '</td><td><button class="ghost" data-ws="' + esc(w.id) + '">Inspect</button></td></tr>';
        }).join("") + "</tbody></table></div>";
      Array.prototype.forEach.call(document.querySelectorAll("[data-ws]"), function (b) {
        b.addEventListener("click", function () { showWorkspace(b.getAttribute("data-ws")); });
      });
    }).catch(function (e) { $("wsList").innerHTML = '<p class="err">' + esc(e.message) + "</p>"; });
  }

  function showWorkspace(id) {
    $("wsDetail").innerHTML = '<p class="muted">Loading tree…</p>';
    api("/api/workspaces/" + encodeURIComponent(id)).then(function (d) {
      var g = d.git;
      var gitLine = g.isRepo
        ? '<span class="pill PASS">repo</span> branch <code>' + esc(g.branch || "detached") +
          "</code> at <code>" + esc(g.head || "?") + "</code>" +
          (g.clean ? ' <span class="muted">clean</span>'
                   : ' <span class="muted">' + g.changes.length + " changed</span>") +
          (g.ahead || g.behind ? ' <span class="muted">(ahead ' + (g.ahead || 0) + ", behind " + (g.behind || 0) + ")</span>" : "")
        : '<span class="pill WARN">not a git repo</span> ' + esc(g.error || "");
      $("wsDetail").innerHTML = '<div class="card"><div class="row">' + gitLine + "</div>" +
        '<p class="muted" style="margin:9px 0 0">' + esc(d.workspace.root) + " &middot; " +
        d.treeStats.files + " files, " + d.treeStats.dirs + " dirs" +
        (d.treeStats.truncated ? " (truncated)" : "") + "</p></div>" +
        '<div class="card tree">' + renderTree(d.tree, "") + "</div>" +
        (g.changes.length ? '<div class="card"><h2 style="margin-top:0">Changes</h2><pre>' +
          esc(g.changes.join("\n")) + "</pre></div>" : "");
    }).catch(function (e) { $("wsDetail").innerHTML = '<p class="err">' + esc(e.message) + "</p>"; });
  }

  $("wsOpen").addEventListener("click", function () {
    var p = $("wsPath").value.trim();
    if (!p) return;
    api("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, host: $("wsHost").value || "local" })
    }).then(function () { $("wsPath").value = ""; loadWorkspaces(); })
      .catch(function (e) { $("wsDetail").innerHTML = '<p class="err">' + esc(e.message) + "</p>"; });
  });

  /* ---- chat ---- */
  var messages = [];
  function pushMsg(role, text) {
    messages.push({ role: role, content: text });
    var div = document.createElement("div");
    div.className = "msg " + role;
    div.textContent = text;
    $("chatLog").appendChild(div);
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
  }

  function loadProviders() {
    api("/api/providers").then(function (r) {
      var opts = ['<option value="auto">auto (AInterceptor routes)</option>'];
      (r.providers || []).forEach(function (p) {
        var st = p.status ? " — " + p.status : "";
        opts.push('<option value="' + esc(p.name) + '">' + esc(p.name + st) + "</option>");
      });
      $("chatModel").innerHTML = opts.join("");
      $("providerNote").textContent = "backend " + r.backend + " · " + (r.providers || []).length + " providers";
    }).catch(function (e) {
      $("providerNote").textContent = "provider list unavailable: " + e.message;
      $("chatModel").innerHTML = '<option value="auto">auto</option>';
    });
  }
  $("loadProviders").addEventListener("click", loadProviders);

  $("chatSend").addEventListener("click", function () {
    var text = $("chatInput").value.trim();
    if (!text) return;
    pushMsg("user", text);
    $("chatInput").value = "";
    var btn = $("chatSend");
    btn.disabled = true;
    btn.textContent = "Thinking…";
    api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages, model: $("chatModel").value || "auto" })
    }).then(function (r) {
      pushMsg("assistant", r.text || "(empty reply)");
    }).catch(function (e) {
      pushMsg("error", e.message);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = "Send";
    });
  });

  /* ---- events ---- */
  $("loadEvents").addEventListener("click", function () {
    api("/api/events").then(function (evs) {
      if (!evs.length) { $("eventsOut").innerHTML = '<p class="muted">No events yet.</p>'; return; }
      $("eventsOut").innerHTML = '<div class="card"><table><thead><tr><th>Time</th><th>Kind</th><th>Session</th><th>Data</th></tr></thead><tbody>' +
        evs.slice().reverse().map(function (e) {
          return "<tr><td>" + esc((e.ts || "").slice(11, 19)) + "</td><td><code>" + esc(e.kind) +
            "</code></td><td>" + esc(e.session) + '</td><td><span class="muted">' +
            esc(JSON.stringify(e.data || {}).slice(0, 220)) + "</span></td></tr>";
        }).join("") + "</tbody></table></div>";
    }).catch(function (e) { $("eventsOut").innerHTML = '<p class="err">' + esc(e.message) + "</p>"; });
  });

  /* ---- boot ---- */
  runDiag(false);
  loadProviders();
  loadWorkspaces();
})();
