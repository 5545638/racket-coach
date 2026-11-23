#!/usr/bin/env python3
"""Replacement butt cap that carries a bare Espruino Puck.js v2 PCB.

The racket side copies the stock Wilson cap (flange + octagonal collar that
goes into the handle), so it mounts exactly like the original. On the outside
the cap carries a cup for the Puck PCB. The cup is narrower than the flange,
so nothing sticks out sideways past the grip; the racket gets ~12 mm longer.

Print in PETG (100 % infill). The cup's rim is split into flexible fingers so
the PCB snaps in and is held against the coin cell.

Coordinates (mm): z = 0 is the flange face that sits against the handle;
+z points away from the racket (outside), the collar extends towards −z.

Default dimensions were measured from photos of a Wilson Blade cap against a
ruler (±0.5 mm) and should be confirmed with calipers before the final print. Print `--fit-test` first: it is
the racket side only (~10 min) to check the fit in the handle.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import asdict, dataclass, fields
from pathlib import Path

import numpy as np
import trimesh
from manifold3d import CrossSection, Manifold

SEGMENTS = 96


@dataclass(frozen=True)
class ButtCapParams:
    # Stock cap — MEASURE (estimates from photos of a Wilson Blade cap).
    # Flange: same orientation as the collar (long axis = width). From photos,
    # scaled by the measured collar.
    flange_width: float = 35.0
    flange_length: float = 32.0
    flange_chamfer: float = 7.5  # leg length of the 45° cut corners
    flange_thickness: float = 1.8
    # Collar, measured on the stock cap (outer faces): 30 × 26 mm across the
    # flats, straight sides 14 mm (long) and 10 mm (short), diagonals ≈ 11–12 mm.
    collar_width: float = 30.0
    collar_length: float = 26.0
    collar_chamfer: float = 8.0  # leg length of the 45° cut corners
    collar_wall: float = 2.0
    collar_depth: float = 5.2  # how far it goes into the handle
    # The measured size is the widest part: the rim (barb) at the tip of the
    # collar. `rim_inset` shrinks it per side to fit the handle; the collar
    # body is `rim_protrusion` smaller per side again, so the rim stands proud.
    rim_inset: float = 0.6
    rim_protrusion: float = 1.0
    rim_height: float = 1.2
    rim_taper: float = 0.5  # per side at the tip, so it lead-ins like a cone

    # Puck.js v2 bare PCB with CR2032 fitted (Espruino: 29 mm dia, 9 mm thick).
    pcb_diameter: float = 29.0
    pcb_stack_height: float = 9.0

    # Cup for the PCB.
    cup_wall: float = 1.2
    radial_clearance: float = 0.3
    stack_interference: float = 0.2  # presses the coin cell into its holder
    lip_width: float = 1.2
    lip_height: float = 1.0
    finger_slots: int = 4
    finger_slot_width: float = 1.5
    finger_slot_depth: float = 5.0

    def cup_outer_diameter(self) -> float:
        return self.pcb_diameter + 2 * (self.radial_clearance + self.cup_wall)

    def validate(self) -> None:
        inner = min(self.collar_width, self.collar_length) - 2 * (
            self.rim_inset + self.rim_protrusion + self.collar_wall
        )
        if inner <= 2:
            raise ValueError("Collar too small for its wall, rim and inset")
        if self.collar_width >= self.flange_width or self.collar_length >= self.flange_length:
            raise ValueError("The collar must be smaller than the flange")
        if self.cup_outer_diameter() > min(self.flange_width, self.flange_length) + 0.01:
            raise ValueError(
                f"Puck cup ({self.cup_outer_diameter():.1f} mm) would stick out past the flange"
            )


def octagon(width: float, length: float, chamfer: float) -> CrossSection:
    """Rectangle with 45° cut corners, centred on the origin."""
    w, l, c = width / 2, length / 2, chamfer
    points = [(-w + c, -l), (w - c, -l), (w, -l + c), (w, l - c), (w - c, l), (-w + c, l), (-w, l - c), (-w, -l + c)]
    return CrossSection([points])


def inset_octagon(width: float, length: float, chamfer: float, d: float) -> CrossSection:
    """The octagon offset inwards by `d` on every side (corners stay 45°)."""
    return octagon(width - 2 * d, length - 2 * d, max(0.0, chamfer - d * (2 - math.sqrt(2))))


def _cylinder(height: float, radius: float) -> Manifold:
    return Manifold.cylinder(height, radius, radius, SEGMENTS)


def build_racket_side(p: ButtCapParams) -> Manifold:
    """Flange and collar: the part that copies the stock cap."""
    p.validate()
    flange = Manifold.extrude(octagon(p.flange_width, p.flange_length, p.flange_chamfer), p.flange_thickness)

    def collar_outline(d: float) -> CrossSection:
        return inset_octagon(p.collar_width, p.collar_length, p.collar_chamfer, d)

    body_inset = p.rim_inset + p.rim_protrusion
    body = Manifold.extrude(collar_outline(body_inset), p.collar_depth)
    # Rim: narrow at the tip (z = 0 here), full size where it meets the body.
    rim = Manifold.hull(
        Manifold.extrude(collar_outline(p.rim_inset + p.rim_taper), 0.01)
        + Manifold.extrude(collar_outline(p.rim_inset), 0.01).translate([0, 0, p.rim_height - 0.01])
    )
    hollow = Manifold.extrude(collar_outline(body_inset + p.collar_wall), p.collar_depth + 0.02).translate(
        [0, 0, -0.01]
    )
    collar = (body + rim - hollow).translate([0, 0, -p.collar_depth])
    return flange + collar


def build(p: ButtCapParams) -> Manifold:
    cap = build_racket_side(p)
    inner_r = p.pcb_diameter / 2 + p.radial_clearance
    outer_r = inner_r + p.cup_wall
    cavity_h = p.pcb_stack_height - p.stack_interference
    z0 = p.flange_thickness
    cup = _cylinder(cavity_h + p.lip_height, outer_r).translate([0, 0, z0])
    cup = cup - _cylinder(cavity_h, inner_r).translate([0, 0, z0])
    cup = cup - _cylinder(p.lip_height + 0.02, inner_r - p.lip_width).translate([0, 0, z0 + cavity_h - 0.01])
    # Slots split the rim into fingers that flex when the PCB is pushed in.
    top = z0 + cavity_h + p.lip_height
    for k in range(p.finger_slots):
        angle = 360 * k / p.finger_slots + 45
        slot = (
            Manifold.cube([outer_r + 1, p.finger_slot_width, p.finger_slot_depth + 0.01])
            .translate([0, -p.finger_slot_width / 2, top - p.finger_slot_depth])
            .rotate([0, 0, angle])
        )
        cup = cup - slot
    return cap + cup


def to_trimesh(solid: Manifold) -> trimesh.Trimesh:
    mesh = solid.to_mesh()
    return trimesh.Trimesh(
        vertices=np.asarray(mesh.vert_properties)[:, :3], faces=np.asarray(mesh.tri_verts), process=True
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    for f in fields(ButtCapParams):
        parser.add_argument(f"--{f.name.replace('_', '-')}", type=type(f.default), default=f.default)
    parser.add_argument("--fit-test", action="store_true", help="racket side only, to check the fit")
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "out")
    args = parser.parse_args()

    params = ButtCapParams(**{f.name: getattr(args, f.name) for f in fields(ButtCapParams)})
    solid = build_racket_side(params) if args.fit_test else build(params)
    mesh = to_trimesh(solid)
    if not mesh.is_watertight:
        raise SystemExit("Generated mesh is not watertight")

    # Print as exported: outermost face on the bed, collar pointing up, no supports.
    mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))
    mesh.apply_translation([0, 0, -mesh.bounds[0][2]])
    mesh = trimesh.Trimesh(vertices=mesh.vertices, faces=mesh.faces, process=True)

    args.out.mkdir(parents=True, exist_ok=True)
    stem = "buttcap-fit-test" if args.fit_test else "buttcap-puck"
    mesh.export(args.out / f"{stem}.3mf")
    mesh.export(args.out / f"{stem}.stl")
    e = mesh.extents
    print(f"Wrote {stem}.3mf/.stl to {args.out}")
    print(f"Size {e[0]:.1f} × {e[1]:.1f} × {e[2]:.1f} mm, {mesh.volume / 1000:.2f} cm³")
    print(f"Parameters: {asdict(params)}")


if __name__ == "__main__":
    main()
