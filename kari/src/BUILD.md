# kari/app.js is built from kari/src

`kari/app.js` is the artefact the browser loads. It is **generated** by concatenating the files in
this directory in filename order, and editing it directly will be overwritten by the next build.

```
./build-app.py            rebuild kari/app.js from kari/src
./build-app.py --check    exit non-zero if app.js is not the derivation of src
```

## Why concatenation and not a bundler

The plan calls for modules with the bundle verified by derivation and tree-shaking off. Two of those
come free here and the third is the reason for the choice.

**Tree-shaking is off because there is none.** `app.js` dispatches through string-keyed maps
(`EV_HOLDS`, `SSTATE`, `VIS_LABEL`, `PLAT_EN`), and a renderer reached only by key is invisible to
static analysis. That is the same class as `creditLine` missing from the surface table, which let
`???? · Bun?Bun` reach a reader. A bundler that decided one of those maps was unused would drop a
renderer silently.

**The checks evaluate what ships, and also the modules.** `adapters/interface.py` runs the real
`app.js` in a Node vm. Because the build is concatenation, evaluating `app.js` IS evaluating the
modules' text, so the gap the plan worried about does not exist here: there is no transformation to
verify, only an ordering.

**esbuild was not available.** `./test.py` blocks the network and nothing is vendored, so a standard
bundler could not be installed. Swapping one in later is a change to `build-app.py` alone, and the
derivation check is what would catch it going wrong.

## The order is the semantics

The files share one scope, as `app.js` always has. Filename order is the concatenation order, and
`00-`, `10-`, `20-` exist so that order is visible rather than alphabetical by accident. A function
hoists, a `const` does not, so moving a file changes behaviour.

## What is in each

| file | what it holds |
|---|---|
| `00-head.js` | preferences, storage, the language switch, `T` and `L` |
| `10-names.js` | 併記, English names and readings, and the floor under an English page |
| `20-app.js` | everything the pages draw |

`10-names.js` is the layer the extracted facts feed: `romanisation`, `reading` and `division`
produce what it renders.
