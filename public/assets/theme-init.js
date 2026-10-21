/* ARVORECER — aplica o tema salvo antes da página ser pintada (carregado no <head>, sem defer). */
(function () {
  try {
    var stored = localStorage.getItem("arvorecer-theme");
    if (stored === "dark" || stored === "light") {
      document.documentElement.dataset.theme = stored;
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.dataset.theme = "dark";
    }
  } catch (e) { /* armazenamento bloqueado: segue com o tema claro */ }
})();
