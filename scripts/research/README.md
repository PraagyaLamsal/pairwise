# Research scripts

These are static-analysis helpers used to study how Tuple renders annotations (see HANDOFF.md and
docs/RESEARCH.md). They read a Tuple app bundle that you download and keep outside this repo. No
Tuple code or assets are stored here.

```sh
python3 -m venv /tmp/revenv && /tmp/revenv/bin/pip install capstone lief numpy
/tmp/revenv/bin/python -I tuple_calls.py /path/to/Tuple.app/Contents/MacOS/Tuple 'StrokeStyle|addQuadCurve|CGContextSetLine' 40 20
/tmp/revenv/bin/python -I tuple_disasm.py /path/to/Tuple.app/Contents/MacOS/Tuple 1006829b0 100682a64
```

* `tuple_calls.py` lists every call site of the imported APIs whose names match the regex. For
  each one it shows the constants loaded into argument registers just before the call: `fmov`
  immediates, `mov`/`movk`→`fmov` doubles, and literal pools.
* `tuple_disasm.py` disassembles an address range of the arm64 slice.
