const api = acquireVsCodeApi();
document.getElementById("choose-folder").onclick = () => api.postMessage({ type: "choose-folder" });
document.getElementById("check-folder").onclick = () => api.postMessage({ type: "check-folder" });

document.getElementById("connect").onclick = () => api.postMessage({ type: "connect" });
