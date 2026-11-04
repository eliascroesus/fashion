# Style guide: the 7 look styles

Every look gets **one** style (rarely two). The same 7 are the style chips in the taste picker, and in Phase 3 the AI tags new looks with these definitions. Ids in brackets are what the code and `looks.json` use; they never change.

**The rule:** pick the style someone would notice first, at a glance.

## Minimal (`minimal`): clean and calm
- **Look for:** neutral colours (white, black, grey, beige, camel, navy), plain fabrics with no logos or prints, simple shapes, few accessories. A white tee with straight trousers, a simple knit, a long plain coat.
- Scandi and "quiet luxury" (expensive-looking basics) go here.
- **Not:** big logos, bright colours, lots of layers or jewellery.

## Streetwear (`streetwear`): relaxed city style (skate and sneaker culture)
- **Look for:** hoodies, graphic tees, oversized fits, cargo or baggy jeans, puffer jackets, caps and beanies, chunky sneakers, visible logos.
- **Not:** gym outfits (that's Sporty) or tailored pieces.

## Classic (`classic`): timeless and put-together
- **Look for:** blazers, shirts and blouses, tailored trousers, trench coats, fine knitwear, loafers, polos, pleated skirts. Things you could wear to work or a nice dinner.
- Preppy (cable knits, polos, loafers, the "college" look) goes here.
- **Not:** plain neutral basics with no tailoring (that's Minimal).

## Sporty (`sporty`): athletic and comfy
- **Look for:** leggings, joggers, sports bras, tracksuits, track jackets, running shoes, matching sets, technical fabrics. The gym look, also when worn in town.
- **Not:** hoodie + cargo + sneakers styled for the street (that's Streetwear).

## Romantic (`romantic`): soft and feminine
- **Look for:** dresses and skirts, florals, lace, ruffles, puff sleeves, pastels, flowy fabrics.
- Boho (earthy tones, prints, fringe, maxi dresses, the festival look) goes here.
- **Not:** a sleek black dress with leather (that's Edgy) or a plain neutral dress (that's Minimal).

## Edgy (`edgy`): bold, dark, a bit rebellious
- **Look for:** lots of black, leather jackets, studs and chains, combat or Chelsea boots, ripped denim, band tees, grunge layering, a rock or punk feel.
- **Not:** all black but plain and clean (that's Minimal).

## Colorful (`colorful`): bold and happy
- **Look for:** bright or clashing colours, bold prints and patterns, colour blocking, statement pieces, a "maximalist" or "dopamine dressing" feel. The colour is the first thing you notice.
- **Not:** one bright piece in an otherwise calm outfit (file it under its main style), a colourful gym set (Sporty), or a colourful street outfit where the hoodie-and-sneakers shape stands out more (Streetwear).

## When you're unsure
- Hoodie and sneakers in town → Streetwear. Gym clothes → Sporty.
- Blazer or tailoring → Classic. Everything plain and neutral → Minimal.
- Black plus leather or studs → Edgy. Black but plain → Minimal.
- A dress with prints or softness → Romantic.
- The colour is what you notice first → Colorful.
- Men's and women's outfits use the same seven.

## Sorting the seed photos (Google Drive)
- One folder per style: `Minimal`, `Streetwear`, `Classic`, `Sporty`, `Romantic`, `Edgy`, `Colorful`.
- A look with several photos (front, back, details): its own sub-folder inside the style folder, up to 10 photos.
- Aim for at least 20 looks per style.
- Occasion (everyday, work, date, party, wedding, travel, sport, festival) and season are suggested from the photos when they're loaded, and checked by Elias.

Adding a style later is a small change: shared list + database enum + i18n label. Never rename or remove one.
