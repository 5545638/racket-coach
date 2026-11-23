"""Geometry checks for the string clamp. Run: pytest hardware/clip"""

import pytest

from clip import ClipParams, build_bottom, build_top, clamped_thickness, to_trimesh

MEASUREMENTS = [(12.5, 1.25), (11.0, 1.30), (13.5, 1.20)]


@pytest.mark.parametrize("spacing,gauge", MEASUREMENTS)
def test_parts_are_printable_solids(spacing: float, gauge: float) -> None:
    p = ClipParams(main_spacing=spacing, string_gauge=gauge)
    for part in (build_top(p), build_bottom(p)):
        mesh = to_trimesh(part)
        assert mesh.is_watertight
        assert mesh.is_volume


@pytest.mark.parametrize("spacing,gauge", MEASUREMENTS)
def test_halves_clamp_the_strings_without_touching_each_other(spacing: float, gauge: float) -> None:
    p = ClipParams(main_spacing=spacing, string_gauge=gauge)
    top, bottom = build_top(p), build_bottom(p)
    assert (top ^ bottom).is_empty()
    gap = to_trimesh(top).bounds[0][2] - to_trimesh(bottom).bounds[1][2]
    assert gap == pytest.approx(p.clamp_gap, abs=1e-6)


def test_housing_fits_the_puck_pcb_and_the_free_string_area() -> None:
    p = ClipParams()
    mesh = to_trimesh(build_top(p))
    expected = p.pcb_diameter + 2 * (p.radial_clearance + p.wall)
    assert mesh.extents[0] == pytest.approx(expected, abs=0.05)
    assert mesh.extents[1] < 36


def test_m2x6_screws_reach_through_the_nut() -> None:
    p = ClipParams()
    assert 6.0 >= clamped_thickness(p) - 0.3  # gap closes when tightened
    assert 6.0 <= clamped_thickness(p) + 0.1  # no sharp tip below the plate


def test_rejects_implausible_measurements() -> None:
    with pytest.raises(ValueError):
        build_top(ClipParams(main_spacing=25))
    with pytest.raises(ValueError):
        build_bottom(ClipParams(string_gauge=2.0))
