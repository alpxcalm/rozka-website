# rozka-website

Static site for https://rozka.work, served by GitHub Pages.

`index.html` is the one file to edit. After changing it, run:

```
node scripts/build.mjs
```

That regenerates `automation/`, `about/` and `contact/`, the SEO head tags, `sitemap.xml`, `robots.txt`, `llms.txt` and `404.html`. Titles, descriptions and the domain are in the config at the top of `scripts/build.mjs`.

To preview real URLs locally: `python3 -m http.server`.
