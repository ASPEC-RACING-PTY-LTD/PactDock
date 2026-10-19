// Signature pad for the signing page. Records strokes in a 600x200 coordinate
// space as "x,y x,y;x,y ..." in the hidden "strokes" field. No dependencies.
(function () {
  "use strict";
  var canvas = document.getElementById("pad");
  var field = document.getElementById("strokes");
  var clear = document.getElementById("pad-clear");
  if (!canvas || !field) return;
  var ctx = canvas.getContext("2d");
  var strokes = [];
  var current = null;

  function point(e) {
    var r = canvas.getBoundingClientRect();
    var x = ((e.clientX - r.left) / r.width) * 600;
    var y = ((e.clientY - r.top) / r.height) * 200;
    return [Math.max(0, Math.min(600, Math.round(x * 10) / 10)), Math.max(0, Math.min(200, Math.round(y * 10) / 10))];
  }

  function draw() {
    ctx.clearRect(0, 0, 600, 200);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111";
    strokes.forEach(function (s) {
      ctx.beginPath();
      s.forEach(function (p, i) {
        if (i === 0) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
      });
      ctx.stroke();
    });
    field.value = strokes
      .map(function (s) {
        return s.map(function (p) { return p[0] + "," + p[1]; }).join(" ");
      })
      .join(";");
    if (strokes.length) {
      var drawn = document.querySelector('input[name="signatureType"][value="drawn"]');
      if (drawn) drawn.checked = true;
    }
  }

  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId);
    current = [point(e)];
    strokes.push(current);
    draw();
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!current) return;
    current.push(point(e));
    draw();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (type) {
    canvas.addEventListener(type, function () { current = null; });
  });
  if (clear) {
    clear.addEventListener("click", function () {
      strokes = [];
      draw();
    });
  }
})();
