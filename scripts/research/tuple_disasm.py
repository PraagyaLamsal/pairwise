import sys, lief, capstone
fat = lief.MachO.parse(sys.argv[1]); b = [x for x in fat if x.header.cpu_type == lief.MachO.Header.CPU_TYPE.ARM64][0]
t = b.get_section('__text'); data = bytes(t.content)
start, end = int(sys.argv[2], 16), int(sys.argv[3], 16)
md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_ARM)
for i in md.disasm(data[start - t.virtual_address:end - t.virtual_address], start):
    print(f'{i.address:#x}  {i.mnemonic:8} {i.op_str}')
