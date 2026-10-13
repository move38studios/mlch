// mlch.app/admin: friend codes and accounts (cloud/src/admin.ts).
"use strict";

const $ = (id) => document.getElementById(id);

async function api(path, init) {
  const response = await fetch(`/api/admin/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Error ${response.status}`);
  return body;
}

const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function row(cells) {
  const tr = document.createElement("tr");
  for (const cell of cells) tr.append(cell instanceof Node ? cell : el("td", cell));
  return tr;
}

/* friend codes */

async function loadCodes() {
  $("codes-error").textContent = "";
  try {
    const { codes } = await api("codes");
    const body = $("codes");
    body.replaceChildren();
    for (const code of codes) {
      const action = el("td");
      if (code.active) {
        const off = el("button", "Turn off");
        off.type = "button";
        off.addEventListener("click", async () => {
          off.disabled = true;
          try {
            await api(`codes/${encodeURIComponent(code.id)}/off`, { method: "POST", body: "{}" });
            await loadCodes();
          } catch (error) {
            $("codes-error").textContent = error.message;
            off.disabled = false;
          }
        });
        action.append(off);
      } else {
        action.append(el("span", `Off ${when(code.deactivatedAt)}`, "off"));
      }
      const tr = row([el("td", code.code, "code"), `${code.percent}%`, `${code.used ?? "?"} of ${code.uses}`, when(code.expiresAt) || "Never", when(code.createdAt), code.createdBy, action]);
      if (!code.active) tr.className = "off";
      body.append(tr);
    }
  } catch (error) {
    $("codes-error").textContent = error.message;
  }
}

$("new-code").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = form.querySelector("button");
  button.disabled = true;
  $("codes-error").textContent = "";
  try {
    await api("codes", {
      method: "POST",
      body: JSON.stringify({ code: data.get("code"), uses: Number(data.get("uses")), percent: Number(data.get("percent")), expires: data.get("expires") || null }),
    });
    form.reset();
    await loadCodes();
  } catch (error) {
    $("codes-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

/* accounts */

function deleteControls(account, cell) {
  const start = el("button", "Delete account");
  start.type = "button";
  start.addEventListener("click", () => {
    start.hidden = true;
    const box = el("div", undefined, "confirm");
    const input = el("input");
    input.placeholder = "Type the email";
    input.autocomplete = "off";
    const confirm = el("button", "Delete", "danger");
    confirm.type = "button";
    confirm.disabled = true;
    const cancel = el("button", "Cancel");
    cancel.type = "button";
    input.addEventListener("input", () => {
      confirm.disabled = input.value.trim().toLowerCase() !== account.email.toLowerCase();
    });
    cancel.addEventListener("click", () => {
      box.remove();
      start.hidden = false;
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        await api(`accounts/${encodeURIComponent(account.id)}/delete`, { method: "POST", body: JSON.stringify({ email: input.value.trim() }) });
        await loadAccounts();
      } catch (error) {
        $("accounts-error").textContent = error.message;
        confirm.disabled = false;
      }
    });
    box.append(input, confirm, cancel);
    cell.append(box);
    input.focus();
  });
  cell.append(start);
}

async function loadAccounts() {
  $("accounts-error").textContent = "";
  try {
    const { accounts } = await api("accounts");
    const body = $("accounts");
    body.replaceChildren();
    for (const account of accounts) {
      const action = el("td");
      deleteControls(account, action);
      const status = account.status ? `${account.status}${account.periodEnd ? `, to ${when(account.periodEnd)}` : ""}` : "None";
      body.append(row([account.email, status, account.code ?? "", account.shares, when(account.createdAt), action]));
    }
  } catch (error) {
    $("accounts-error").textContent = error.message;
  }
}

api("me")
  .then(({ email }) => {
    $("who").textContent = email;
  })
  .catch(() => {});
loadCodes();
loadAccounts();
