# Fonts

`jetbrains-mono-latin.woff2` is a Latin subset of **JetBrains Mono**, variable, all
weights, self-hosted.

Copyright 2020 The JetBrains Mono Project Authors
(<https://github.com/JetBrains/JetBrainsMono>), used under the SIL Open Font License 1.1.
The full licence is in [OFL.txt](OFL.txt) beside the font, as that licence requires.

It is served from this site and nowhere else, deliberately. Switching to a font CDN would
end the site's zero-external-requests property and hand every visitor to a third party.

**Ligatures must stay disabled.** JetBrains Mono composes `+>` into a single arrow glyph,
which silently destroys the `Schelling+>` wordmark. The `font-variant-ligatures: none` and
`font-feature-settings: "calt" 0, "liga" 0` rules in `src/overview.css` are load-bearing.
