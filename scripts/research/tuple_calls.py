"""Targeted static analysis of Tuple's arm64 slice: find call sites of imported SwiftUI /
CoreGraphics / AppKit APIs that shape annotation rendering, and recover the constant
arguments loaded right before each call (fmov immediates, mov/movk → fmov, literal pools).

Usage: python tuple_calls.py <Tuple binary> <regex for import names> [window]
"""
import re
import struct
import sys

import capstone
import lief
import numpy as np

path, pattern = sys.argv[1], sys.argv[2]
WINDOW = int(sys.argv[3]) if len(sys.argv) > 3 else 40

fat = lief.MachO.parse(path)
binary = None
for b in fat:
    if b.header.cpu_type == lief.MachO.Header.CPU_TYPE.ARM64:
        binary = b
assert binary is not None

text = binary.get_section('__text')
text_addr, text_bytes = text.virtual_address, bytes(text.content)

# GOT slot -> imported symbol name
got = {}
for bnd in binary.bindings:
    try:
        name = bnd.symbol.name if bnd.has_symbol else None
    except Exception:
        name = None
    if name:
        got[bnd.address] = name

# __stubs: adrp x16, page ; ldr x16, [x16, off] ; br x16
stubs = {}
for secname in ('__stubs', '__auth_stubs'):
    s = binary.get_section(secname)
    if not s:
        continue
    data = bytes(s.content)
    for i in range(0, len(data) - 11, 12):
        a, l, _ = struct.unpack_from('<III', data, i)
        pc = s.virtual_address + i
        if (a & 0x9F00001F) != 0x90000010:
            continue
        immlo = (a >> 29) & 3
        immhi = (a >> 5) & 0x7FFFF
        imm = (immhi << 2) | immlo
        if imm & (1 << 20):
            imm -= 1 << 21
        page = (pc & ~0xFFF) + (imm << 12)
        off = ((l >> 10) & 0xFFF) * 8
        slot = page + off
        if slot in got:
            stubs[pc] = got[slot]

rx = re.compile(pattern)
wanted = {pc: n for pc, n in stubs.items() if rx.search(n)}
print(f'# {len(stubs)} stubs, {len(wanted)} matching {pattern!r}')

words = np.frombuffer(text_bytes[: len(text_bytes) // 4 * 4], dtype='<u4')
is_bl = (words & 0xFC000000) == 0x94000000
idx = np.nonzero(is_bl)[0]
imm = (words[idx] & 0x03FFFFFF).astype(np.int64)
imm = np.where(imm & (1 << 25), imm - (1 << 26), imm)
targets = text_addr + idx.astype(np.int64) * 4 + imm * 4

md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_ARM)
md.detail = False

def read_va(va, n):
    for seg in binary.segments:
        if seg.virtual_address <= va < seg.virtual_address + seg.virtual_size:
            off = va - seg.virtual_address
            data = bytes(seg.content)
            return data[off: off + n]
    return None

def window(callsite):
    start = max(text_addr, callsite - WINDOW * 4)
    code = text_bytes[start - text_addr: callsite - text_addr + 4]
    return list(md.disasm(code, start))

def describe(insns):
    """Resolve float constants and small ints written to argument registers."""
    regs = {}
    notes = []
    for ins in insns:
        m, op = ins.mnemonic, ins.op_str
        if m in ('mov', 'movz') and re.match(r'^[xw]\d+, #', op):
            r, v = op.split(', #')
            regs[r.replace('w', 'x')] = int(v, 0) & 0xFFFFFFFFFFFFFFFF
        elif m == 'movk' and ', lsl #' in op:
            r, rest = op.split(', #', 1)
            v, sh = rest.split(', lsl #')
            r = r.replace('w', 'x')
            regs[r] = (regs.get(r, 0) & ~(0xFFFF << int(sh))) | (int(v, 0) << int(sh))
        elif m == 'adrp':
            r, v = op.split(', #')
            regs['page:' + r] = int(v, 0)
        if m == 'fmov':
            dst, src = op.split(', ', 1)
            if src.startswith('#'):
                notes.append(f'{ins.address:#x} {dst} = {src[1:]}')
            elif re.match(r'^x\d+$', src) and src in regs:
                val = struct.unpack('<d', struct.pack('<Q', regs[src]))[0]
                notes.append(f'{ins.address:#x} {dst} = {val!r} (via {src})')
            elif re.match(r'^w\d+$', src) and src.replace('w', 'x') in regs:
                val = struct.unpack('<f', struct.pack('<I', regs[src.replace('w', 'x')] & 0xFFFFFFFF))[0]
                notes.append(f'{ins.address:#x} {dst} = {val!r}f (via {src})')
        if m == 'ldr' and re.match(r'^[ds]\d+, \[x\d+, #', op):
            dst, rest = op.split(', [', 1)
            base, off = rest.rstrip(']').split(', #')
            page = regs.get('page:' + base)
            if page is not None:
                raw = read_va(page + int(off, 0), 8)
                if raw and dst.startswith('d'):
                    notes.append(f'{ins.address:#x} {dst} = {struct.unpack("<d", raw)[0]!r} (literal)')
                elif raw:
                    notes.append(f'{ins.address:#x} {dst} = {struct.unpack("<f", raw[:4])[0]!r}f (literal)')
        if m in ('mov', 'movz', 'orr') and re.match(r'^w[0-3], #', op):
            notes.append(f'{ins.address:#x} {op}')
    return notes

for stub_pc, name in sorted(wanted.items(), key=lambda kv: kv[1]):
    sites = idx[targets == stub_pc]
    print(f'\n== {name}  ({len(sites)} call sites)')
    for s in sites[:int(sys.argv[4]) if len(sys.argv) > 4 else 12]:
        callsite = text_addr + int(s) * 4
        ins = window(callsite)
        print(f'  call @ {callsite:#x}: ' + '; '.join(describe(ins)[-6:]))
