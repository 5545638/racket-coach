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
    flange_width: float = 34.0  # across the flats, side to side
    flange_length: float = 35.0  # across the flats, the other direction
    flange_chamfer: float = 7.5  # leg length of the cut corners
    flange_thickness: float = 1.8
    # Collar outline as measured on the stock cap: an octagon with four straight
    # sides and four shorter diagonal sides (outer faces).
    collar_straight_side: float = 12.0
    collar_diagonal_side: float = 10.0
    collar_wall: float = 2.0
    collar_depth: float = 5.2  # how far it goes into the handle
    # Snap ridge around the tip of the collar, as on the stock cap.
    ridge_height: float = 1.0
    ridge_protrusion: float = 0.3
    collar_clearance: float = 0.0  # + makes the collar smaller for an easier fit

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

    @property
    def collar_chamfer(self) -> float:
        return self.collar_diagonal_side / math.sqrt(2)

    @property
    def collar_width(self) -> float:
        """Across the flats; the same in both directions."""
        return self.collar_straight_side + 2 * self.collar_chamfer

    @property
    def collar_length(self) -> float:
        return self.collar_width

    def cup_outer_diameter(self) -> float:
        return self.pcb_diameter + 2 * (self.radial_clearance + self.cup_wall)

    def validate(self) -> None:
        if self.collar_wall * 2 >= min(self.collar_width, self.collar_length):
            raise ValueError("collar_wall too thick for the collar size")
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


def _cylinder(height: float, radius: float) -> Manifold:
    return Manifold.cylinder(height, radius, radius, SEGMENTS)


def build_racket_side(p: ButtCapParams) -> Manifold:
    """Flange and collar: the part that copies the stock cap."""
    p.validate()
    flange = Manifold.extrude(octagon(p.flange_width, p.flange_length, p.flange_chamfer), p.flange_thickness)
    cw, cl = p.collar_width - 2 * p.collar_clearance, p.collar_length - 2 * p.collar_clearance
    outer = Manifold.extrude(octagon(cw, cl, p.collar_chamfer), p.collar_depth)
    inner_chamfer = max(0.0, p.collar_chamfer - p.collar_wall * (math.sqrt(2) - 1))
    inner = Manifold.extrude(
        octagon(cw - 2 * p.collar_wall, cl - 2 * p.collar_wall, inner_chamfer), p.collar_depth + 0.02
    ).translate([0, 0, -0.01])
    ridge = Manifold.extrude(
        octagon(cw + 2 * p.ridge_protrusion, cl + 2 * p.ridge_protrusion, p.collar_chamfer),
        p.ridge_height,
    )
    collar = (outer + ridge - inner).translate([0, 0, -p.collar_depth])
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
