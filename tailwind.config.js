module.exports = {
  content: ["./public/**/*.{html,js}"],
  theme: {
    extend: {
      colors: {
        sand: "#f8fafc",
        clay: "#e05f2f",
        moss: "#12856f",
        ink: "#172033",
        haze: "#f4f7fb",
      },
      boxShadow: {
        soft: "0 24px 70px rgba(15,23,42,.12)",
      },
      fontFamily: {
        display: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        body: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
