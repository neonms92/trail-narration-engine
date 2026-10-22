// Settings for this deployment. The OAuth client ID is public by design; there are no secrets here.
window.TNE_CONFIG = {
  // Google Cloud → APIs & Services → Credentials → OAuth client ID (Web application). See README.md.
  clientId: "271774184563-49qo8i17v54p880fedjs5f9lhnpqva1u.apps.googleusercontent.com",
  // The folder in My Drive that holds episodes/ (the voice notebook's DRIVE_ROOT).
  driveRoot: "hiker-engine",
  // The voice notebook, opened in Colab from GitHub (the Settings panel links to it).
  notebookUrl: "https://colab.research.google.com/github/neonms92/hiker-engine/blob/main/voice/breeze_voice.ipynb",
};
